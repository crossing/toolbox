// FreeAgent upstream OAuth. FreeAgent publishes no discovery document, so the
// endpoints are hardcoded, and client authentication is client_secret_basic
// (mirrors tools/op-mcp/src/op_mcp/oauth.py). Errors are sanitized: only the
// OAuth error/error_description fields surface, never a raw response body
// that could echo a credential.

export const FREEAGENT_BASE_URL = "https://api.freeagent.com/v2";
export const FREEAGENT_AUTHORIZE_URL = `${FREEAGENT_BASE_URL}/approve_app`;
export const FREEAGENT_TOKEN_URL = `${FREEAGENT_BASE_URL}/token_endpoint`;

// FreeAgent requires a User-Agent on every request; Workers fetch sends none.
export const USER_AGENT = "freeagent-mcp";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

// Never default to a bare `fetch` reference: calling it detached from
// globalThis throws "Illegal invocation" in workerd (Node is tolerant, so
// tests won't catch it).
export const boundFetch: Fetcher = (input, init) => fetch(input, init);

export interface UpstreamTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export class UpstreamError extends Error {}

export function sanitizedTokenError(body: string): string {
  try {
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null) throw new Error();
    const record = payload as Record<string, unknown>;
    const error = typeof record.error === "string" ? record.error : "unknown";
    const description =
      typeof record.error_description === "string" ? record.error_description : "no description";
    return `${error}: ${description}`;
  } catch {
    return "unparseable token endpoint response";
  }
}

interface TokenEndpointResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postTokenEndpoint(
  params: Record<string, string>,
  clientId: string,
  clientSecret: string,
  fetcher: Fetcher,
): Promise<TokenEndpointResponse> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  let response: Response;
  try {
    response = await fetcher(FREEAGENT_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    throw new UpstreamError(`token endpoint unreachable: ${err instanceof Error ? err.message : "fetch failed"}`);
  }
  const text = await response.text();
  if (!response.ok) {
    // FreeAgent answers invalid/expired grants with a bare 401 HTML page, not
    // an OAuth error JSON — surface the status so that case reads sensibly.
    let parses = false;
    try {
      JSON.parse(text);
      parses = true;
    } catch {
      /* not JSON */
    }
    throw new UpstreamError(
      parses
        ? sanitizedTokenError(text)
        : `token endpoint rejected the request (status ${response.status}); the authorization code may have expired — retry the connection`,
    );
  }
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

function toTokens(resp: TokenEndpointResponse, now: number, previousRefreshToken?: string): UpstreamTokens {
  const refreshToken = resp.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new UpstreamError("token endpoint returned no refresh token");
  // FreeAgent access tokens normally live 7 days; fall back conservatively.
  const expiresIn = typeof resp.expires_in === "number" && resp.expires_in > 0 ? resp.expires_in : 3600;
  return { accessToken: resp.access_token, refreshToken, expiresAt: now + expiresIn * 1000 };
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
    { grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri },
    opts.clientId,
    opts.clientSecret,
    opts.fetcher ?? boundFetch,
  );
  return toTokens(resp, opts.now ?? Date.now());
}

export async function refreshUpstream(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: number;
  fetcher?: Fetcher;
}): Promise<UpstreamTokens> {
  const resp = await postTokenEndpoint(
    { grant_type: "refresh_token", refresh_token: opts.refreshToken },
    opts.clientId,
    opts.clientSecret,
    opts.fetcher ?? boundFetch,
  );
  return toTokens(resp, opts.now ?? Date.now(), opts.refreshToken);
}

export function buildAuthorizeRedirect(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(FREEAGENT_AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}
