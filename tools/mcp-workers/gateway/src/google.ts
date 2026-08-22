// Google OAuth for the gateway, two distinct flows against the same client:
//
// - Identity: connector auth and manage sign-in authenticate the human with
//   openid+email and nothing else. No offline access, no refresh token — the
//   access token is used once for userinfo and dropped.
// - Linking: /manage kicks off a real service-scope authorization
//   (access_type=offline + prompt=consent) whose refresh token is what the
//   vault stores; Gmail/Drive tool calls run on tokens refreshed from it.
//
// Never request the cloud-platform scope: Workspace accounts then die on
// Google Cloud session reauth (invalid_rapt) — see the op-oauth history.

import { boundFetch, sanitizedTokenError, type Fetcher } from "@toolbox/mcp-shared";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const IDENTITY_SCOPES = ["openid", "email"];

// Link scopes are minimized per link: a read-only link never asks Google for
// write scopes at all. openid+email ride along so the callback can label the
// account by its address.
export const GOOGLE_READ_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const GOOGLE_WRITE_SCOPES = [
  ...GOOGLE_READ_SCOPES,
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/drive",
];

// A linked account carries write capability iff its granted scopes include
// any of the write-only ones (granular consent can subset what we asked for).
export function scopesAllowWrite(scopes: string[]): boolean {
  return scopes.some((scope) => !GOOGLE_READ_SCOPES.includes(scope) && GOOGLE_WRITE_SCOPES.includes(scope));
}

export interface UpstreamTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export class UpstreamError extends Error {}

export function buildIdentityRedirect(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", IDENTITY_SCOPES.join(" "));
  url.searchParams.set("state", opts.state);
  // No access_type=offline / prompt=consent: identity-only, no refresh token
  // wanted, and silent re-auth keeps the manage sign-in painless.
  return url.toString();
}

export function buildLinkRedirect(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("state", opts.state);
  // Both are required for Google to issue a refresh token.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function postTokenEndpoint(
  params: Record<string, string>,
  fetcher: Fetcher,
): Promise<TokenEndpointResponse> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    throw new UpstreamError(`token endpoint unreachable: ${err instanceof Error ? err.message : "fetch failed"}`);
  }
  const text = await response.text();
  if (!response.ok) throw new UpstreamError(sanitizedTokenError(text));
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new UpstreamError("unparseable token endpoint response");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record?.access_token !== "string" || record.access_token === "") {
    throw new UpstreamError(sanitizedTokenError(text));
  }
  return record as unknown as TokenEndpointResponse;
}

function expiry(resp: TokenEndpointResponse, now: number): number {
  const expiresIn = typeof resp.expires_in === "number" && resp.expires_in > 0 ? resp.expires_in : 3600;
  return now + expiresIn * 1000;
}

// Exchanges an identity code and returns the short-lived access token.
export async function exchangeIdentityCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetcher?: Fetcher;
}): Promise<string> {
  const resp = await postTokenEndpoint(
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    opts.fetcher ?? boundFetch,
  );
  return resp.access_token;
}

// Exchanges a link code; the refresh token is the point of the exercise.
// `scopes` reports what Google actually granted (granular consent can subset
// the request), falling back to the requested list when absent.
export async function exchangeLinkCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  requestedScopes: string[];
  now?: number;
  fetcher?: Fetcher;
}): Promise<{ tokens: UpstreamTokens; scopes: string[] }> {
  const resp = await postTokenEndpoint(
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    opts.fetcher ?? boundFetch,
  );
  if (!resp.refresh_token) {
    // Happens if prompt=consent was lost; without it the link dies with the
    // 1h access token.
    throw new UpstreamError("Google returned no refresh token; retry the link");
  }
  return {
    tokens: {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresAt: expiry(resp, opts.now ?? Date.now()),
    },
    scopes: typeof resp.scope === "string" && resp.scope !== "" ? resp.scope.split(" ") : opts.requestedScopes,
  };
}

export async function refreshUpstream(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: number;
  fetcher?: Fetcher;
}): Promise<UpstreamTokens> {
  const resp = await postTokenEndpoint(
    {
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    opts.fetcher ?? boundFetch,
  );
  return {
    accessToken: resp.access_token,
    // Google does not rotate refresh tokens on use.
    refreshToken: opts.refreshToken,
    expiresAt: expiry(resp, opts.now ?? Date.now()),
  };
}

// Best-effort revocation of a linked account's grant at unlink time, so no
// live refresh token dangles upstream after the vault row is gone.
export async function revokeToken(token: string, fetcher: Fetcher = boundFetch): Promise<boolean> {
  try {
    const response = await fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchUserEmail(accessToken: string, fetcher: Fetcher = boundFetch): Promise<string> {
  const response = await fetcher(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new UpstreamError(`userinfo request failed (status ${response.status})`);
  const payload = (await response.json()) as { email?: unknown };
  return typeof payload.email === "string" ? payload.email : "";
}

// Owner gate: comma-separated allowlist, case-insensitive, whitespace-tolerant.
export function emailAllowed(email: string, allowedCsv: string): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return allowedCsv
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .includes(normalized);
}
