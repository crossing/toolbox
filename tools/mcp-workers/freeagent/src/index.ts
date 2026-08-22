// freeagent-mcp — Phase 1: real FreeAgent OAuth upstream + read tool surface.
//
// Flow: claude.ai → /authorize (local consent page, write checkbox) →
// FreeAgent /v2/approve_app (owner logs in) → /callback (code exchange,
// company gate) → grant completed with the upstream tokens in encrypted
// props. Downstream token refreshes re-refresh the upstream token when it is
// close to expiry (FreeAgent access tokens live ~7 days; claude.ai refreshes
// our 1h tokens far more often, so tool calls always see a fresh token).

import {
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  decodeAuthRequest,
  encodeAuthRequest,
  escapeHtml,
  grantedScopes,
  hasScope,
  renderApprovalPage,
  requireWrite,
  WRITE_SCOPE,
  type OwnerProps,
} from "@toolbox/mcp-shared";
import { FreeAgentClient, fetchCompanySubdomain } from "./api";
import { registerReadTools } from "./tools";
import {
  buildAuthorizeRedirect,
  exchangeCode,
  refreshUpstream,
  UpstreamError,
  type UpstreamTokens,
} from "./upstream";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  FREEAGENT_READ_MCP: DurableObjectNamespace;
  FREEAGENT_RW_MCP: DurableObjectNamespace;
  // Secrets (wrangler secret / op-cf-secrets):
  FREEAGENT_CLIENT_ID: string;
  FREEAGENT_CLIENT_SECRET: string;
  ALLOWED_COMPANY: string; // FreeAgent company subdomain of the owner
}

export interface FreeagentProps extends OwnerProps {
  upstream: UpstreamTokens;
}

// What travels through FreeAgent's `state` parameter: the original downstream
// auth request plus the scopes the human approved on the consent page.
interface PendingAuth {
  authRequest: AuthRequest;
  scopes: string[];
}

const SERVER_NAME = "freeagent";
const SERVER_VERSION = "0.2.0";

// Refresh the upstream token once it has less than a day left. claude.ai
// refreshes the downstream token hourly-ish, so this keeps the upstream token
// perpetually fresh without any DO-side refresh machinery.
const UPSTREAM_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export class FreeagentReadMCP extends McpAgent<Env, unknown, FreeagentProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init() {
    registerReadTools(this.server, () => {
      const upstream = this.props?.upstream;
      if (!upstream) throw new UpstreamError("grant is missing upstream credentials; reconnect this connector");
      return new FreeAgentClient(upstream.accessToken);
    });
    if (hasScope(this.props, WRITE_SCOPE)) {
      // Phase 3 replaces this spike with the real write tools.
      this.server.registerTool(
        "ping_write",
        {
          description: "Connectivity spike for the write endpoint: pretends to write.",
          inputSchema: { message: z.string() },
        },
        async ({ message }) => ({
          content: [{ type: "text", text: JSON.stringify({ wrote: message }) }],
        }),
      );
    }
  }
}

// Same agent code; a separate DO class so read and rw sessions never share
// instances and the wrangler binding names the split explicitly.
export class FreeagentRwMCP extends FreeagentReadMCP {}

const readHandler = FreeagentReadMCP.serve("/mcp", { binding: "FREEAGENT_READ_MCP" });
const rwHandler = requireWrite(FreeagentRwMCP.serve("/rw", { binding: "FREEAGENT_RW_MCP" }));

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
    // Hand off to FreeAgent: only someone who can log in to the owner's
    // FreeAgent account (checked again at /callback) can finish the flow.
    return Response.redirect(
      buildAuthorizeRedirect({
        clientId: env.FREEAGENT_CLIENT_ID,
        redirectUri: `${url.origin}/callback`,
        state,
      }),
      302,
    );
  }

  return new Response("method not allowed", { status: 405 });
}

async function handleCallback(env: Env, url: URL): Promise<Response> {
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return htmlError(403, `FreeAgent authorization failed: ${upstreamError}`);
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
      clientId: env.FREEAGENT_CLIENT_ID,
      clientSecret: env.FREEAGENT_CLIENT_SECRET,
      code,
      redirectUri: `${url.origin}/callback`,
    });
  } catch (err) {
    return htmlError(502, err instanceof UpstreamError ? err.message : "upstream token exchange failed");
  }

  // Owner gate: the authorizing FreeAgent user must belong to the configured
  // company. A stranger's login succeeds upstream but is rejected here, and
  // no grant is created.
  const subdomain = await fetchCompanySubdomain(new FreeAgentClient(upstream.accessToken));
  if (!subdomain || subdomain !== env.ALLOWED_COMPANY) {
    return htmlError(403, "this connector is not available for your FreeAgent account");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.authRequest,
    userId: subdomain,
    metadata: { phase: "freeagent-read" },
    scope: pending.scopes,
    props: { userId: subdomain, scopes: pending.scopes, upstream } satisfies FreeagentProps,
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

// tokenExchangeCallback receives no env, so the default-export wrapper below
// captures it per-request (module state is per-isolate and requests are
// handled one callback chain at a time).
let currentEnv: Env | undefined;

async function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | void> {
  if (options.grantType !== "refresh_token") return;
  const env = currentEnv;
  const props = options.props as FreeagentProps | undefined;
  if (!env || !props?.upstream?.refreshToken) return;
  if (props.upstream.expiresAt - Date.now() > UPSTREAM_REFRESH_MARGIN_MS) return;
  const upstream = await refreshUpstream({
    clientId: env.FREEAGENT_CLIENT_ID,
    clientSecret: env.FREEAGENT_CLIENT_SECRET,
    refreshToken: props.upstream.refreshToken,
  });
  return { newProps: { ...props, upstream } };
}

const provider = new OAuthProvider({
  apiHandlers: {
    "/mcp": readHandler,
    "/rw": rwHandler,
  },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
  tokenExchangeCallback,
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    currentEnv = env;
    return provider.fetch(request, env, ctx);
  },
};
