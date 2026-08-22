// gws-mcp — Google Workspace (Gmail + Drive) remote MCP server.
//
// Same shape as freeagent-mcp: single /mcp endpoint, consent-page write
// checkbox → "write" scope → conditional tool registration; identity gate at
// /callback compares the Google account email against ALLOWED_EMAILS.
// Upstream scopes are minimized per grant: a read-only grant only ever asks
// Google for the readonly scopes. Google access tokens live ~1h, so the DO
// refreshes in-process from the grant's refresh token (see api.ts).

import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import {
  decodeAuthRequest,
  encodeAuthRequest,
  escapeHtml,
  grantedScopes,
  hasScope,
  renderApprovalPage,
  WRITE_SCOPE,
  type OwnerProps,
} from "@toolbox/mcp-shared";
import { GoogleClient, TokenSource } from "./api";
import { registerDriveReadTools, registerDriveWriteTools } from "./drive";
import { registerGmailReadTools, registerGmailWriteTools } from "./gmail";
import {
  buildAuthorizeRedirect,
  emailAllowed,
  exchangeCode,
  fetchUserEmail,
  READ_UPSTREAM_SCOPES,
  UpstreamError,
  WRITE_UPSTREAM_SCOPES,
  type UpstreamTokens,
} from "./upstream";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GWS_MCP: DurableObjectNamespace;
  // Secrets (op-cf-secrets):
  GWS_CLIENT_ID: string;
  GWS_CLIENT_SECRET: string;
  ALLOWED_EMAILS: string; // comma-separated Google account emails
}

export interface GwsProps extends OwnerProps {
  upstream: UpstreamTokens;
}

interface PendingAuth {
  authRequest: AuthRequest;
  scopes: string[];
}

const SERVER_NAME = "gws";
const SERVER_VERSION = "0.1.0";

export class GwsMCP extends McpAgent<Env, unknown, GwsProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  private tokenSource?: TokenSource;

  async init() {
    const getClient = () => {
      const upstream = this.props?.upstream;
      if (!upstream) throw new UpstreamError("grant is missing upstream credentials; reconnect this connector");
      this.tokenSource ??= new TokenSource(this.env.GWS_CLIENT_ID, this.env.GWS_CLIENT_SECRET, upstream);
      return new GoogleClient(this.tokenSource);
    };
    registerGmailReadTools(this.server, getClient);
    registerDriveReadTools(this.server, getClient);
    if (hasScope(this.props, WRITE_SCOPE)) {
      registerGmailWriteTools(this.server, getClient);
      registerDriveWriteTools(this.server, getClient);
    }
  }
}

const mcpHandler = GwsMCP.serve("/mcp", { binding: "GWS_MCP" });

function htmlError(status: number, message: string): Response {
  return new Response(
    `<!doctype html><html><body><h1>${SERVER_NAME}</h1><p>${escapeHtml(message)}</p></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET") {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
    const page = renderApprovalPage({
      serverName: SERVER_NAME,
      clientName: client?.clientName ?? authRequest.clientId,
      redirectUri: authRequest.redirectUri,
      requestedScopes: authRequest.scope,
      encodedAuthRequest: encodeAuthRequest(authRequest),
      offerWrite: true,
    });
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const encoded = form.get("auth_request");
    if (typeof encoded !== "string") {
      return new Response("missing auth_request", { status: 400 });
    }
    const authRequest = decodeAuthRequest<AuthRequest>(encoded);
    const scopes = grantedScopes(authRequest.scope, form.get("allow_write") === "1");
    const state = encodeAuthRequest({ authRequest, scopes } satisfies PendingAuth);
    return Response.redirect(
      buildAuthorizeRedirect({
        clientId: env.GWS_CLIENT_ID,
        redirectUri: `${url.origin}/callback`,
        state,
        scopes: scopes.includes(WRITE_SCOPE) ? WRITE_UPSTREAM_SCOPES : READ_UPSTREAM_SCOPES,
      }),
      302,
    );
  }

  return new Response("method not allowed", { status: 405 });
}

async function handleCallback(env: Env, url: URL): Promise<Response> {
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return htmlError(403, `Google authorization failed: ${upstreamError}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return new Response("missing code or state", { status: 400 });

  let pending: PendingAuth;
  try {
    pending = decodeAuthRequest<PendingAuth>(state);
    if (!pending?.authRequest || !Array.isArray(pending.scopes)) throw new Error();
  } catch {
    return new Response("invalid state", { status: 400 });
  }

  let upstream: UpstreamTokens;
  try {
    upstream = await exchangeCode({
      clientId: env.GWS_CLIENT_ID,
      clientSecret: env.GWS_CLIENT_SECRET,
      code,
      redirectUri: `${url.origin}/callback`,
    });
  } catch (err) {
    return htmlError(502, err instanceof UpstreamError ? err.message : "upstream token exchange failed");
  }

  // Owner gate: only the allowlisted Google accounts may bind this worker.
  const email = await fetchUserEmail(upstream.accessToken);
  if (!emailAllowed(email, env.ALLOWED_EMAILS)) {
    return htmlError(403, "this connector is not available for your Google account");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.authRequest,
    userId: email,
    metadata: { phase: "gws-read" },
    scope: pending.scopes,
    props: { userId: email, scopes: pending.scopes, upstream } satisfies GwsProps,
  });
  return Response.redirect(redirectTo, 302);
}

const authHandler = {
  async fetch(request: Request, rawEnv: unknown, _ctx: ExecutionContext): Promise<Response> {
    const env = rawEnv as Env;
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env, url);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(env, url);
    return new Response("not found", { status: 404 });
  },
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
});
