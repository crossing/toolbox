// The management interface: a tiny server-rendered app on /manage where the
// owner toggles services, sees linked accounts, and (from G1) links new ones.
// Authenticated by the same Google identity sign-in as the connector, with
// its own HMAC-signed session cookie — no dependency on any MCP grant.
//
// CSRF posture: session cookie is SameSite=Lax + HttpOnly + Secure, so
// cross-site form POSTs never carry it; the login flow pins a nonce cookie
// against the signed OAuth state.

import { escapeHtml } from "@toolbox/mcp-shared";
import { randomToken, signToken, verifyToken } from "./crypto";
import { vaultFor, type Env } from "./env";
import {
  buildIdentityRedirect,
  emailAllowed,
  exchangeIdentityCode,
  fetchUserEmail,
  UpstreamError,
} from "./google";
import { defaultServiceToggles, SERVICES } from "./registry";
import type { AccountInfo } from "./vault";

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
</style></head>
<body>${body}</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function renderManagePage(email: string, services: Record<string, boolean>, accounts: AccountInfo[]): string {
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
      ? `<tr><td colspan="3" class="muted">No linked accounts yet — account linking arrives with the first real service module.</td></tr>`
      : accounts
          .map(
            (acct) => `<tr>
      <td>${escapeHtml(acct.service)}</td>
      <td>${escapeHtml(acct.label)}${acct.isDefault ? " (default)" : ""}</td>
      <td>${acct.enabled ? "enabled" : "disabled"}</td>
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
<table><tr><th>Service</th><th>Account</th><th>Status</th></tr>
${accountRows}
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
    return page("gateway", renderManagePage(email, config.services, config.accounts));
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

  if (url.pathname === "/manage/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: { location: "/manage", "set-cookie": clearCookie(SESSION_COOKIE) },
    });
  }

  return new Response("not found", { status: 404 });
}
