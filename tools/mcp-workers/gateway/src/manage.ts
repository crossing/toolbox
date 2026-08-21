// The management interface: a tiny server-rendered app on /manage where the
// owner toggles services, links/unlinks Google accounts, and picks defaults.
// Authenticated by the same Google identity sign-in as the connector, with
// its own HMAC-signed session cookie — no dependency on any MCP grant.
//
// CSRF posture: session cookie is SameSite=Lax + HttpOnly + Secure, so
// cross-site form POSTs never carry it; the login and link flows each pin a
// nonce cookie against their signed OAuth state (Lax cookies do ride along
// on Google's top-level redirect back to /callback).

import { escapeHtml } from "@toolbox/mcp-shared";
import { encryptJson, decryptJson, importVaultKey, randomToken, signToken, verifyToken } from "./crypto";
import { vaultFor, type Env } from "./env";
import {
  buildIdentityRedirect,
  buildLinkRedirect,
  emailAllowed,
  exchangeIdentityCode,
  exchangeLinkCode,
  fetchUserEmail,
  GOOGLE_READ_SCOPES,
  GOOGLE_WRITE_SCOPES,
  revokeToken,
  scopesAllowWrite,
  UpstreamError,
} from "./google";
import {
  buildFreeagentAuthorizeRedirect,
  exchangeFreeagentCode,
  fetchCompanySubdomain,
  FreeAgentUpstreamError,
  staticClient,
} from "./freeagentapi";
import { defaultServiceToggles, FREEAGENT_ACCOUNT_SERVICE, GOOGLE_ACCOUNT_SERVICE, SERVICES } from "./registry";
import type { AccountInfo, AuditEntry } from "./vault";

// What a vault account row's ciphertext decrypts to. Google blobs carry only
// the refresh token (access tokens live ~1h, not worth persisting; Google
// never rotates refresh tokens). FreeAgent blobs persist the full set:
// access tokens live ~7 days, and the refresh token may rotate on use.
export interface VaultBlob {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // epoch ms
}

const SESSION_COOKIE = "gateway_session";
const NONCE_COOKIE = "gateway_login_nonce";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

interface SessionPayload {
  kind: "session";
  email: string;
  exp: number;
}

interface LoginState {
  kind: "manage-login";
  nonce: string;
  exp: number;
}

interface LinkState {
  kind: "link";
  owner: string; // the manage session's email — whose vault gets the account
  write: boolean;
  nonce: string;
  exp: number;
}

interface FreeagentLinkState {
  kind: "link-freeagent";
  owner: string;
  nonce: string;
  exp: number;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name: string): string {
  return setCookie(name, "", 0);
}

export async function sessionEmail(request: Request, env: Env): Promise<string | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifyToken<SessionPayload>(env.COOKIE_SECRET, token);
  if (!payload || payload.kind !== "session" || payload.exp < Date.now()) return null;
  // Removing an email from the allowlist revokes its live sessions too.
  if (!emailAllowed(payload.email, env.ALLOWED_EMAILS)) return null;
  return payload.email;
}

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0 1.6rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  form { display: inline; }
  button { padding: .25rem .9rem; }
  .muted { color: #666; font-size: .9rem; }
  .linkbox { border: 1px solid #ddd; padding: .8rem 1rem; margin: .8rem 0 1.6rem; }
</style></head>
<body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function renderAuditRows(audit: AuditEntry[]): string {
  if (audit.length === 0) {
    return `<tr><td colspan="4" class="muted">No write calls recorded yet.</td></tr>`;
  }
  return audit
    .map(
      (entry) => `<tr>
      <td class="muted">${escapeHtml(new Date(entry.ts).toISOString().replace("T", " ").slice(0, 19))}</td>
      <td>${escapeHtml(entry.tool)}</td>
      <td>${escapeHtml(entry.status)}</td>
      <td class="muted">${escapeHtml(entry.summary)}</td>
    </tr>`,
    )
    .join("\n");
}

function renderManagePage(
  email: string,
  services: Record<string, boolean>,
  accounts: AccountInfo[],
  audit: AuditEntry[],
): string {
  const serviceRows = SERVICES.map((svc) => {
    const enabled = services[svc.id] ?? svc.defaultEnabled;
    const action = enabled ? "Disable" : "Enable";
    return `<tr>
      <td><strong>${escapeHtml(svc.title)}</strong><div class="muted">${escapeHtml(svc.description)}</div></td>
      <td>${enabled ? "enabled" : "disabled"}</td>
      <td><form method="post" action="/manage/services">
        <input type="hidden" name="service" value="${escapeHtml(svc.id)}">
        <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}">
        <button type="submit">${action}</button>
      </form></td>
    </tr>`;
  }).join("\n");

  const accountRows =
    accounts.length === 0
      ? `<tr><td colspan="4" class="muted">No linked accounts yet.</td></tr>`
      : accounts
          .map(
            (acct) => `<tr>
      <td>${escapeHtml(acct.service)}</td>
      <td>${escapeHtml(acct.label)}${acct.isDefault ? " <strong>(default)</strong>" : ""}</td>
      <td>${scopesAllowWrite(acct.scopes) ? "read + write" : "read-only"}</td>
      <td>
        ${
          acct.isDefault
            ? ""
            : `<form method="post" action="/manage/accounts">
          <input type="hidden" name="action" value="default">
          <input type="hidden" name="service" value="${escapeHtml(acct.service)}">
          <input type="hidden" name="label" value="${escapeHtml(acct.label)}">
          <button type="submit">Set default</button>
        </form>`
        }
        <form method="post" action="/manage/accounts">
          <input type="hidden" name="action" value="unlink">
          <input type="hidden" name="service" value="${escapeHtml(acct.service)}">
          <input type="hidden" name="label" value="${escapeHtml(acct.label)}">
          <button type="submit">Unlink</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  return `<h1>gateway</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>.
<form method="post" action="/manage/logout"><button type="submit">Sign out</button></form></p>
<p class="muted">Changes affect which tools the connector offers; active conversations pick them up
when they next check, new conversations immediately.</p>
<h2>Services</h2>
<table><tr><th>Service</th><th>Status</th><th></th></tr>
${serviceRows}
</table>
<h2>Linked accounts</h2>
<table><tr><th>Service</th><th>Account</th><th>Access</th><th></th></tr>
${accountRows}
</table>
<div class="linkbox">
  <form method="post" action="/manage/link">
    <label><input type="checkbox" name="write" value="1"> include write scopes (drafts, labels, filters, Drive edits)</label>
    <button type="submit">Link a Google account</button>
  </form>
  <div class="muted">Opens Google's consent screen; the account you approve there becomes the
  linked account (it must be on the gateway's allowlist). Relinking an account replaces its
  stored grant — use it to change access level.</div>
</div>
<div class="linkbox">
  <form method="post" action="/manage/link-freeagent">
    <button type="submit">Link the FreeAgent account</button>
  </form>
  <div class="muted">Opens FreeAgent's sign-in; only the allowlisted company can complete the
  link. Relinking replaces the stored grant.</div>
</div>
<h2>Audit log</h2>
<p class="muted">The most recent write-tool calls (including refused and failed ones).</p>
<table><tr><th>Time (UTC)</th><th>Tool</th><th>Status</th><th>Arguments</th></tr>
${renderAuditRows(audit)}
</table>`;
}

async function handleLogin(env: Env, url: URL): Promise<Response> {
  const nonce = randomToken();
  const state = await signToken(env.COOKIE_SECRET, {
    kind: "manage-login",
    nonce,
    exp: Date.now() + LOGIN_TTL_MS,
  } satisfies LoginState);
  const redirect = buildIdentityRedirect({
    clientId: env.GWS_CLIENT_ID,
    redirectUri: `${url.origin}/callback`,
    state: `m.${state}`,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect,
      "set-cookie": setCookie(NONCE_COOKIE, nonce, LOGIN_TTL_MS / 1000),
    },
  });
}

// Invoked from the worker's shared /callback route for "m."-prefixed states.
export async function handleManageCallback(
  request: Request,
  env: Env,
  url: URL,
  stateToken: string,
): Promise<Response> {
  const state = await verifyToken<LoginState>(env.COOKIE_SECRET, stateToken);
  if (!state || state.kind !== "manage-login" || state.exp < Date.now()) {
    return page("gateway", "<p>Sign-in expired — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  if (getCookie(request, NONCE_COOKIE) !== state.nonce) {
    return page("gateway", "<p>Sign-in did not originate here — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("gateway", "<p>Google returned no code.</p>", 400);

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
    const message = err instanceof UpstreamError ? err.message : "sign-in failed";
    return page("gateway", `<p>${escapeHtml(message)}</p>`, 502);
  }
  if (!emailAllowed(email, env.ALLOWED_EMAILS)) {
    return page("gateway", "<p>This gateway is not available for your Google account.</p>", 403);
  }

  const session = await signToken(env.COOKIE_SECRET, {
    kind: "session",
    email,
    exp: Date.now() + SESSION_TTL_MS,
  } satisfies SessionPayload);
  const headers = new Headers({ location: "/manage" });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000));
  headers.append("set-cookie", clearCookie(NONCE_COOKIE));
  return new Response(null, { status: 302, headers });
}

// Account linking: a signed-in owner kicks off a real service-scope Google
// authorization; the approved account's refresh token lands encrypted in the
// owner's vault, labelled by the account's email.
async function handleLinkStart(request: Request, env: Env, url: URL, owner: string): Promise<Response> {
  const form = await request.formData();
  const write = form.get("write") === "1";
  const nonce = randomToken();
  const state = await signToken(env.COOKIE_SECRET, {
    kind: "link",
    owner,
    write,
    nonce,
    exp: Date.now() + LOGIN_TTL_MS,
  } satisfies LinkState);
  const redirect = buildLinkRedirect({
    clientId: env.GWS_CLIENT_ID,
    redirectUri: `${url.origin}/callback`,
    state: `l.${state}`,
    scopes: write ? GOOGLE_WRITE_SCOPES : GOOGLE_READ_SCOPES,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect,
      "set-cookie": setCookie(NONCE_COOKIE, nonce, LOGIN_TTL_MS / 1000),
    },
  });
}

// Invoked from the worker's shared /callback route for "l."-prefixed states.
export async function handleLinkCallback(
  request: Request,
  env: Env,
  url: URL,
  stateToken: string,
): Promise<Response> {
  const state = await verifyToken<LinkState>(env.COOKIE_SECRET, stateToken);
  if (!state || state.kind !== "link" || state.exp < Date.now()) {
    return page("gateway", "<p>Link flow expired — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  if (getCookie(request, NONCE_COOKIE) !== state.nonce) {
    return page("gateway", "<p>Link did not originate here — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  // The vault being written must belong to the live manage session.
  const owner = await sessionEmail(request, env);
  if (!owner || owner !== state.owner) {
    return page("gateway", "<p>Manage session expired — <a href=\"/manage\">sign in and retry</a>.</p>", 403);
  }
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return page("gateway", `<p>Google authorization failed: ${escapeHtml(upstreamError)}</p>`, 403);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("gateway", "<p>Google returned no code.</p>", 400);

  const requested = state.write ? GOOGLE_WRITE_SCOPES : GOOGLE_READ_SCOPES;
  let label: string;
  let refreshToken: string;
  let scopes: string[];
  try {
    const result = await exchangeLinkCode({
      clientId: env.GWS_CLIENT_ID,
      clientSecret: env.GWS_CLIENT_SECRET,
      code,
      redirectUri: `${url.origin}/callback`,
      requestedScopes: requested,
    });
    refreshToken = result.tokens.refreshToken;
    scopes = result.scopes;
    label = (await fetchUserEmail(result.tokens.accessToken)).trim().toLowerCase();
  } catch (err) {
    const message = err instanceof UpstreamError ? err.message : "link failed";
    return page("gateway", `<p>${escapeHtml(message)}</p>`, 502);
  }
  // The linked account itself must be allowlisted, not just the owner.
  if (!emailAllowed(label, env.ALLOWED_EMAILS)) {
    await revokeToken(refreshToken);
    return page("gateway", "<p>That Google account is not on this gateway's allowlist.</p>", 403);
  }

  const key = await importVaultKey(env.VAULT_KEY);
  const ciphertext = await encryptJson(key, { refreshToken } satisfies VaultBlob);
  await vaultFor(env, owner).putAccount(GOOGLE_ACCOUNT_SERVICE, label, ciphertext, scopes);
  return new Response(null, {
    status: 302,
    headers: { location: "/manage", "set-cookie": clearCookie(NONCE_COOKIE) },
  });
}

// FreeAgent linking: no scope choice (FreeAgent OAuth has no scopes) and the
// account label is the company subdomain, gated against ALLOWED_COMPANY.
async function handleFreeagentLinkStart(env: Env, url: URL, owner: string): Promise<Response> {
  const nonce = randomToken();
  const state = await signToken(env.COOKIE_SECRET, {
    kind: "link-freeagent",
    owner,
    nonce,
    exp: Date.now() + LOGIN_TTL_MS,
  } satisfies FreeagentLinkState);
  const redirect = buildFreeagentAuthorizeRedirect({
    clientId: env.FREEAGENT_CLIENT_ID,
    redirectUri: `${url.origin}/callback`,
    state: `f.${state}`,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: redirect,
      "set-cookie": setCookie(NONCE_COOKIE, nonce, LOGIN_TTL_MS / 1000),
    },
  });
}

// Invoked from the worker's shared /callback route for "f."-prefixed states.
export async function handleFreeagentLinkCallback(
  request: Request,
  env: Env,
  url: URL,
  stateToken: string,
): Promise<Response> {
  const state = await verifyToken<FreeagentLinkState>(env.COOKIE_SECRET, stateToken);
  if (!state || state.kind !== "link-freeagent" || state.exp < Date.now()) {
    return page("gateway", "<p>Link flow expired — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  if (getCookie(request, NONCE_COOKIE) !== state.nonce) {
    return page("gateway", "<p>Link did not originate here — <a href=\"/manage\">try again</a>.</p>", 400);
  }
  const owner = await sessionEmail(request, env);
  if (!owner || owner !== state.owner) {
    return page("gateway", "<p>Manage session expired — <a href=\"/manage\">sign in and retry</a>.</p>", 403);
  }
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) {
    return page("gateway", `<p>FreeAgent authorization failed: ${escapeHtml(upstreamError)}</p>`, 403);
  }
  const code = url.searchParams.get("code");
  if (!code) return page("gateway", "<p>FreeAgent returned no code.</p>", 400);

  let tokens;
  try {
    tokens = await exchangeFreeagentCode({
      clientId: env.FREEAGENT_CLIENT_ID,
      clientSecret: env.FREEAGENT_CLIENT_SECRET,
      code,
      redirectUri: `${url.origin}/callback`,
    });
  } catch (err) {
    const message = err instanceof FreeAgentUpstreamError ? err.message : "link failed";
    return page("gateway", `<p>${escapeHtml(message)}</p>`, 502);
  }
  // Owner gate: the authorizing FreeAgent user must belong to the configured
  // company. A stranger's login succeeds upstream but no account is linked.
  const subdomain = await fetchCompanySubdomain(staticClient(tokens.accessToken));
  if (!subdomain || subdomain !== env.ALLOWED_COMPANY) {
    return page("gateway", "<p>That FreeAgent account is not this gateway's company.</p>", 403);
  }

  const key = await importVaultKey(env.VAULT_KEY);
  const ciphertext = await encryptJson(key, {
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  } satisfies VaultBlob);
  await vaultFor(env, owner).putAccount(FREEAGENT_ACCOUNT_SERVICE, subdomain, ciphertext, []);
  return new Response(null, {
    status: 302,
    headers: { location: "/manage", "set-cookie": clearCookie(NONCE_COOKIE) },
  });
}

export async function handleManage(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/manage/login" && request.method === "GET") {
    return handleLogin(env, url);
  }

  const email = await sessionEmail(request, env);
  if (url.pathname === "/manage" && request.method === "GET") {
    if (!email) {
      return page(
        "gateway",
        `<h1>gateway</h1><p><a href="/manage/login">Sign in with Google</a> to manage services and accounts.</p>`,
      );
    }
    const vault = vaultFor(env, email);
    const config = await vault.getCatalogConfig(defaultServiceToggles());
    const audit = await vault.listAudit(50);
    return page("gateway", renderManagePage(email, config.services, config.accounts, audit));
  }

  if (url.pathname === "/manage/services" && request.method === "POST") {
    if (!email) return new Response("not signed in", { status: 401 });
    const form = await request.formData();
    const service = form.get("service");
    const enabled = form.get("enabled");
    if (typeof service !== "string" || !SERVICES.some((svc) => svc.id === service)) {
      return new Response("unknown service", { status: 400 });
    }
    await vaultFor(env, email).setServiceEnabled(service, enabled === "1");
    return new Response(null, { status: 303, headers: { location: "/manage" } });
  }

  if (url.pathname === "/manage/link" && request.method === "POST") {
    if (!email) return new Response("not signed in", { status: 401 });
    return handleLinkStart(request, env, url, email);
  }

  if (url.pathname === "/manage/link-freeagent" && request.method === "POST") {
    if (!email) return new Response("not signed in", { status: 401 });
    return handleFreeagentLinkStart(env, url, email);
  }

  if (url.pathname === "/manage/accounts" && request.method === "POST") {
    if (!email) return new Response("not signed in", { status: 401 });
    const form = await request.formData();
    const action = form.get("action");
    const service = form.get("service");
    const label = form.get("label");
    if (typeof service !== "string" || typeof label !== "string" || service === "" || label === "") {
      return new Response("missing service or label", { status: 400 });
    }
    const vault = vaultFor(env, email);
    if (action === "default") {
      await vault.setDefaultAccount(service, label);
    } else if (action === "unlink") {
      // Google grants get revoked upstream first (best-effort) so no live
      // refresh token dangles after the vault row is gone. FreeAgent has no
      // revocation endpoint — revoke from the FreeAgent app settings if
      // needed.
      if (service === GOOGLE_ACCOUNT_SERVICE) {
        const acct = await vault.getAccount(service, label);
        if (acct) {
          try {
            const key = await importVaultKey(env.VAULT_KEY);
            const blob = await decryptJson<VaultBlob>(key, acct.ciphertext);
            await revokeToken(blob.refreshToken);
          } catch {
            // an undecryptable row still gets deleted below
          }
        }
      }
      await vault.deleteAccount(service, label);
    } else {
      return new Response("unknown action", { status: 400 });
    }
    return new Response(null, { status: 303, headers: { location: "/manage" } });
  }

  if (url.pathname === "/manage/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { location: "/manage", "set-cookie": clearCookie(SESSION_COOKIE) },
    });
  }

  return new Response("not found", { status: 404 });
}
