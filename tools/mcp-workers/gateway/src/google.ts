// Google sign-in as *identity only* for the gateway: both the connector OAuth
// and the management session authenticate the human with openid+email and
// nothing else. No offline access, no refresh token — the access token is
// used once for userinfo and dropped. Service scopes (Gmail, Drive, …) are
// requested later by the account-*linking* flow, not here.
//
// Temporary duplication with gws/src/upstream.ts; G1 folds the gws worker in
// and this file absorbs its linking flow.

import { boundFetch, sanitizedTokenError, type Fetcher } from "@toolbox/mcp-shared";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const IDENTITY_SCOPES = ["openid", "email"];

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

// Exchanges an identity code and returns the short-lived access token.
export async function exchangeIdentityCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetcher?: Fetcher;
}): Promise<string> {
  const fetcher = opts.fetcher ?? boundFetch;
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: opts.code,
        redirect_uri: opts.redirectUri,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
      }).toString(),
    });
  } catch (err) {
    throw new UpstreamError(`token endpoint unreachable: ${err instanceof Error ? err.message : "fetch failed"}`);
  }
  const text = await response.text();
  if (!response.ok) throw new UpstreamError(sanitizedTokenError(text));
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new UpstreamError("unparseable token endpoint response");
  }
  if (typeof payload.access_token !== "string" || payload.access_token === "") {
    throw new UpstreamError(sanitizedTokenError(text));
  }
  return payload.access_token;
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
