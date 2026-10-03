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
import { vaultFor, type Env } from "./env";
import { fileUrl, googleClientForUser, grantStoreFor, handleFilesRequest, pinDriveAccount } from "./files/http";
import { signToken } from "./files/signed";
import { FileError } from "./files/types";
import { listTransitFolders, transitCacheKey, trashExpired } from "./files/transit";
import { FreeAgentClient } from "./freeagentapi";
import {
  buildIdentityRedirect,
  emailAllowed,
  exchangeIdentityCode,
  fetchUserEmail,
  UpstreamError,
} from "./google";
import { GoogleClient } from "./googleapi";
import { handleFreeagentLinkCallback, handleLinkCallback, handleManage, handleManageCallback } from "./manage";
import {
  defaultServiceToggles,
  FREEAGENT_ACCOUNT_SERVICE,
  GOOGLE_ACCOUNT_SERVICE,
  registerGatewayTools,
  SERVICES,
  type GatewayToolContext,
} from "./registry";
import { inboxFor } from "./sms";
import { handleSmsHook } from "./smshook";
import { dispatchSms, dlrUrl } from "./smssend";
import { vaultTokenSource, type VaultTokenSource } from "./tokencache";
import { NoLinkedAccountError, ServiceDisabledError } from "./toolutil";
import { bridgeFor } from "./whatsapp";

export { UserVault } from "./vault";
export { SmsInbox } from "./smsinbox";
export type { Env } from "./env";

export type GatewayProps = OwnerProps;

interface PendingAuth {
  authRequest: AuthRequest;
  scopes: string[];
}

const SERVER_NAME = "gateway";
const SERVER_VERSION = "0.4.0";

export class GatewayMCP extends McpAgent<Env, unknown, GatewayProps> {
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // One token source per resolved account, holding only an access token and
  // its expiry; refresh tokens stay in the vault, which alone refreshes. A
  // hibernated DO just asks the vault again on wake.
  private tokenSources = new Map<string, VaultTokenSource>();

  async init() {
    const email = this.props?.userId ?? "";
    const vault = vaultFor(this.env, email);
    // Fail closed per call: enablement and account linkage are re-read from
    // the vault, so manage-page changes bite mid-conversation.
    const assertEnabled = async (service: string) => {
      const def = SERVICES.find((svc) => svc.id === service);
      const enabled = await vault.isServiceEnabled(service, def?.defaultEnabled ?? false);
      if (!enabled) throw new ServiceDisabledError(service);
    };
    const tokenSource = (service: "google" | "freeagent", label: string) => {
      const key = `${service}\n${label}`;
      let source = this.tokenSources.get(key);
      if (!source) {
        source = vaultTokenSource(vault, service, label);
        this.tokenSources.set(key, source);
      }
      return source;
    };
    const ctx: GatewayToolContext = {
      email,
      canWrite: hasScope(this.props, WRITE_SCOPE),
      googleClient: async (service, account) => {
        await assertEnabled(service);
        // Gmail and Drive share the "google" namespace but not necessarily
        // the same account: each resolves its own pin before the namespace
        // default. An explicit `account` argument still wins over both.
        const acct = await vault.getAccountForService(GOOGLE_ACCOUNT_SERVICE, service, account);
        if (!acct) throw new NoLinkedAccountError(service, account);
        return new GoogleClient(tokenSource(GOOGLE_ACCOUNT_SERVICE, acct.label));
      },
      freeagentClient: async () => {
        await assertEnabled("freeagent");
        const acct = await vault.getAccountForService(FREEAGENT_ACCOUNT_SERVICE, "freeagent");
        if (!acct) throw new NoLinkedAccountError("freeagent");
        return new FreeAgentClient(tokenSource(FREEAGENT_ACCOUNT_SERVICE, acct.label));
      },
      whatsappBridge: async () => {
        await assertEnabled("whatsapp");
        return bridgeFor(this.env);
      },
      smsInbox: async () => {
        await assertEnabled("sms");
        return inboxFor(this.env);
      },
      // The delivery-report URL carries the send id, which exists only after
      // the store has opened the row — so it is built per call, not once.
      sendSms: async (sendId, peer, body) =>
        dispatchSms(this.env, peer, body, dlrUrl(this.env, this.env.PUBLIC_ORIGIN ?? "", sendId)),
      listAccounts: async () => vault.listAccounts(),
      transitCache: vault,
      signFileUrl: async (req) => {
        // Checked here rather than left to signToken, so the model is told
        // what is missing instead of getting an opaque failure.
        if (!this.env.FILES_URL_KEY || !this.env.PUBLIC_ORIGIN) {
          throw new FileError(503, "signed file URLs are not configured on this gateway (FILES_URL_KEY / PUBLIC_ORIGIN)");
        }
        const account = await pinDriveAccount(vault, req.account);
        const { token, grant } = await signToken(this.env.FILES_URL_KEY, grantStoreFor(this.env), {
          ...req,
          account,
          userId: email,
        });
        return { url: fileUrl(this.env.PUBLIC_ORIGIN, token), expiresAt: grant.exp };
      },
      audit: async (tool, summary, status) =>
        vault.appendAudit({ ts: Date.now(), tool, summary, status }),
    };

    registerGatewayTools(this.server, ctx);

    // Read once, at connect: the tool list a client sees is fixed for the life
    // of its session. That makes the two toggle directions behave differently,
    // which /manage now says out loud — disabling bites immediately, because
    // assertEnabled runs inside every handler, while enabling needs a new
    // conversation, because there is no handler yet to run it. Registering
    // every service unconditionally would make them symmetric at the cost of
    // putting disabled tools in every client's list; the asymmetry is the
    // better trade, so it is documented rather than removed.
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
    // Before anything else, and deliberately outside the OAuth surface: AAISP
    // posts here with no credential of its own, so the path carries the secret
    // and a mismatch is indistinguishable from a route that does not exist.
    const hook = await handleSmsHook(request, env, url);
    if (hook) return hook;
    if (url.pathname === "/authorize") return handleAuthorize(request, env, url);
    if (url.pathname === "/callback" && request.method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      if (state.startsWith("m.")) return handleManageCallback(request, env, url, state.slice(2));
      if (state.startsWith("l.")) return handleLinkCallback(request, env, url, state.slice(2));
      if (state.startsWith("f.")) return handleFreeagentLinkCallback(request, env, url, state.slice(2));
      if (state.startsWith("c.")) return handleConnectorCallback(env, url, state.slice(2));
      return new Response("invalid state", { status: 400 });
    }
    if (url.pathname === "/manage" || url.pathname.startsWith("/manage/")) {
      return handleManage(request, env, url);
    }
    return new Response("not found", { status: 404 });
  },
};

const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["read", "write"],
});

/**
 * The daily `_Transit` sweep (wrangler.jsonc cron). Durable Objects cannot be
 * enumerated, so the allowlist is the list of users; a user whose vault has
 * never cached a `_Transit` id has never staged a file and costs no Drive
 * call. `_Transit` lives only in the default Drive account (refs.ts refuses
 * a labelled one); every root-level `_Transit` there is swept, not just the
 * cached one, so a duplicate left by a find-or-create race still empties.
 * One user's failure is logged and the sweep moves on.
 */
async function sweepTransit(env: Env, now: number): Promise<void> {
  const emails = (env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  for (const email of emails) {
    try {
      const vault = vaultFor(env, email);
      if (!(await vault.getSetting(transitCacheKey()))) continue;
      const drive = await googleClientForUser(env, email, "drive");
      for (const transitId of await listTransitFolders(drive)) {
        const report = await trashExpired(drive, transitId, now);
        if (report.trashed.length > 0 || report.failed.length > 0) {
          console.log(`transit sweep: trashed ${report.trashed.length}, failed ${report.failed.length}`);
        }
      }
    } catch (err) {
      console.log(`transit sweep failed for one user: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Outside the OAuth provider altogether: a signed file URL is its own
    // bearer credential, carried by sandboxes that hold no OAuth token.
    const files = await handleFilesRequest(request, env);
    if (files) return files;
    return oauthProvider.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepTransit(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
