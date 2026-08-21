// Google upstream OAuth. The Worker reuses the existing OAuth client from the
// gws CLI rollout (client id/secret in 1Password); token requests carry the
// client credentials in the form body (Google's convention), unlike
// FreeAgent's client_secret_basic. Errors are sanitized via the shared
// helper — no response body that could echo a credential ever surfaces.
//
// Never request the cloud-platform scope here: Workspace accounts then die
// on Google Cloud session reauth (invalid_rapt) — see the op-oauth rollout
// history.

import { boundFetch, sanitizedTokenError, type Fetcher } from "@toolbox/mcp-shared";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// Upstream scopes are minimized per grant: a read-only grant never asks
// Google for write scopes at all.
export const READ_UPSTREAM_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const WRITE_UPSTREAM_SCOPES = [
  ...READ_UPSTREAM_SCOPES,
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/drive",
];

export interface UpstreamTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export class UpstreamError extends Error {}

export function buildAuthorizeRedirect(opts: {
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

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  now?: number;
  fetcher?: Fetcher;
}): Promise<UpstreamTokens> {
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
    // Happens if prompt=consent was lost; without it the grant dies with the
    // 1h access token.
    throw new UpstreamError("Google returned no refresh token; retry the connection");
  }
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiresAt: expiry(resp, opts.now ?? Date.now()),
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
