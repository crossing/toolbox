// gateway-mcp — the single MCP endpoint all services sit behind.
//
// Connector OAuth authenticates *identity only* (Google sign-in, openid+email,
// gated by ALLOWED_EMAILS); the grant's props carry the email and permission
// tier, never upstream service tokens. Those live in the per-user vault DO,
// written by the /manage account-linking flow (G1+). The session McpAgent
// assembles its tool catalog from the vault's service toggles at init and
// re-checks enablement on every call, so a disabled service fails closed
// mid-conversation.

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
import { decryptJson, importVaultKey } from "./crypto";
import { vaultFor, type Env } from "./env";
import {
  buildIdentityRedirect,
  emailAllowed,
  exchangeIdentityCode,
  fetchUserEmail,
  UpstreamError,
} from "./google";
import { GoogleClient, TokenSource } from "./googleapi";
import { handleLinkCallback, handleManage, handleManageCallback } from "./manage";
import {
  defaultServiceToggles,
  GOOGLE_ACCOUNT_SERVICE,
  registerGatewayTools,
  SERVICES,
  type GatewayToolContext,
} from "./registry";
import { NoLinkedAccountError, ServiceDisabledError } from "./toolutil";
import type { VaultBlob } from "./manage";

export { UserVault } from "./vault";
export type { Env } from "./env";

export type GatewayProps = OwnerProps;

interface PendingAuth {
  authRequest: AuthRequest;
  scopes: string[];
}

const SERVER_NAME = "gateway";
const SERVER_VERSION = "0.2.0";

export class GatewayMCP extends McpAgent<Env, unknown, GatewayProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // One token source per resolved account label; instance memory only, so a
  // hibernated DO simply re-derives from the vault's refresh token on wake.
  private tokenSources = new Map<string, TokenSource>();

  async init() {
    const email = this.props?.userId ?? "";
    const vault = vaultFor(this.env, email);
    const ctx: GatewayToolContext = {
      email,
      canWrite: hasScope(this.props, WRITE_SCOPE),
      googleClient: async (service, account) => {
        // Fail closed per call: enablement and account linkage are re-read
        // from the vault, so manage-page changes bite mid-conversation.
        const def = SERVICES.find((svc) => svc.id === service);
        const enabled = await vault.isServiceEnabled(service, def?.defaultEnabled ?? false);
        if (!enabled) throw new ServiceDisabledError(service);
        const acct = await vault.getAccount(GOOGLE_ACCOUNT_SERVICE, account);
        if (!acct) throw new NoLinkedAccountError(service, account);
        let source = this.tokenSources.get(acct.label);
        if (!source) {
          const key = await importVaultKey(this.env.VAULT_KEY);
          const blob = await decryptJson<VaultBlob>(key, acct.ciphertext);
          source = new TokenSource(this.env.GWS_CLIENT_ID, this.env.GWS_CLIENT_SECRET, {
            accessToken: "",
            refreshToken: blob.refreshToken,
            expiresAt: 0,
          });
          this.tokenSources.set(acct.label, source);
        }
        return new GoogleClient(source);
      },
      listAccounts: async () => vault.listAccounts(),
    };

    registerGatewayTools(this.server, ctx);

    const config = await vault.getCatalogConfig(defaultServiceToggles());
    for (const svc of SERVICES) {
      if (!config.services[svc.id]) continue;
      svc.registerRead(this.server, ctx);
      if (ctx.canWrite) svc.registerWrite?.(this.server, ctx);
    }
  }
}

const mcpHandler = GatewayMCP.serve("/mcp", { binding: "GATEWAY_MCP" });

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
    const state = `c.${encodeAuthRequest({ authRequest, scopes } satisfies PendingAuth)}`;
    return Response.redirect(
      buildIdentityRedirect({
        clientId: env.GWS_CLIENT_ID,
        redirectUri: `${url.origin}/callback`,
        state,
      }),
      302,
    );
  }

  return new Response("method not allowed", { status: 405 });
}

async function handleConnectorCallback(env: Env, url: URL, state: string): Promise<Response> {
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return htmlError(403, `Google authorization failed: ${upstreamError}`);
  }
  const code = url.searchParams.get("code");
  if (!code) return new Response("missing code", { status: 400 });

  let pending: PendingAuth;
  try {
    pending = decodeAuthRequest<PendingAuth>(state);
    if (!pending?.authRequest || !Array.isArray(pending.scopes)) throw new Error();
  } catch {
    return new Response("invalid state", { status: 400 });
  }

  let email: string;
  try {
    const accessToken = await exchangeIdentityCode({
      clientId: env.GWS_CLIENT_ID,
      clientSecret: env.GWS_CLIENT_SECRET,
      code,
      redirectUri: `${url.origin}/callback`,
    });
    email = await fetchUserEmail(accessToken);
  } catch (err) {
    return htmlError(502, err instanceof UpstreamError ? err.message : "upstream token exchange failed");
  }

  // Owner gate: only allowlisted Google accounts may bind this gateway.
  if (!emailAllowed(email, env.ALLOWED_EMAILS)) {
    return htmlError(403, "this gateway is not available for your Google account");
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.authRequest,
    userId: email,
    metadata: { phase: "gateway-g1" },
    scope: pending.scopes,
    props: { userId: email, scopes: pending.scopes } satisfies GatewayProps,
  });
  return Response.redirect(redirectTo, 302);
}

const authHandler = {
  async fetch(request: Request, rawEnv: unknown, _ctx: ExecutionContext): Promise<Response> {
    const env = rawEnv as Env;
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env, url);
    if (url.pathname === "/callback" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      if (state.startsWith("m.")) return handleManageCallback(request, env, url, state.slice(2));
      if (state.startsWith("l.")) return handleLinkCallback(request, env, url, state.slice(2));
      if (state.startsWith("c.")) return handleConnectorCallback(env, url, state.slice(2));
      return new Response("invalid state", { status: 400 });
    }
    if (url.pathname === "/manage" || url.pathname.startsWith("/manage/")) {
      return handleManage(request, env, url);
    }
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
