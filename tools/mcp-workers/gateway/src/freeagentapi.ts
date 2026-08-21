// FreeAgent upstream OAuth + API client (ported from freeagent-mcp).
// FreeAgent publishes no discovery document, so the endpoints are hardcoded,
// and client authentication is client_secret_basic. Errors are sanitized:
// only the OAuth error/error_description fields surface, never a raw
// response body that could echo a credential.
//
// Token model in the gateway: the vault blob stores the full token set
// (access token ~7 days, refresh token). The session DO uses the stored
// access token until it nears expiry, then refreshes in-process and writes
// the new set back to the vault — FreeAgent MAY rotate the refresh token on
// use, so the write-back is not optional.

import { boundFetch, sanitizedTokenError, type Fetcher } from "@toolbox/mcp-shared";

export const FREEAGENT_BASE_URL = "https://api.freeagent.com/v2";
export const FREEAGENT_AUTHORIZE_URL = `${FREEAGENT_BASE_URL}/approve_app`;
export const FREEAGENT_TOKEN_URL = `${FREEAGENT_BASE_URL}/token_endpoint`;

// FreeAgent requires a User-Agent on every request; Workers fetch sends none.
export const USER_AGENT = "gateway-mcp";

export interface FreeAgentTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export class FreeAgentUpstreamError extends Error {}

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
    throw new FreeAgentUpstreamError(
      `token endpoint unreachable: ${err instanceof Error ? err.message : "fetch failed"}`,
    );
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
    throw new FreeAgentUpstreamError(
      parses
        ? sanitizedTokenError(text)
        : `token endpoint rejected the request (status ${response.status}); the authorization code may have expired — retry the link`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new FreeAgentUpstreamError("unparseable token endpoint response");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record?.access_token !== "string" || record.access_token === "") {
    throw new FreeAgentUpstreamError(sanitizedTokenError(text));
  }
  return record as unknown as TokenEndpointResponse;
}

function toTokens(resp: TokenEndpointResponse, now: number, previousRefreshToken?: string): FreeAgentTokens {
  const refreshToken = resp.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new FreeAgentUpstreamError("token endpoint returned no refresh token");
  // FreeAgent access tokens normally live 7 days; fall back conservatively.
  const expiresIn = typeof resp.expires_in === "number" && resp.expires_in > 0 ? resp.expires_in : 3600;
  return { accessToken: resp.access_token, refreshToken, expiresAt: now + expiresIn * 1000 };
}

export async function exchangeFreeagentCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  now?: number;
  fetcher?: Fetcher;
}): Promise<FreeAgentTokens> {
  const resp = await postTokenEndpoint(
    { grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri },
    opts.clientId,
    opts.clientSecret,
    opts.fetcher ?? boundFetch,
  );
  return toTokens(resp, opts.now ?? Date.now());
}

export async function refreshFreeagent(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now?: number;
  fetcher?: Fetcher;
}): Promise<FreeAgentTokens> {
  const resp = await postTokenEndpoint(
    { grant_type: "refresh_token", refresh_token: opts.refreshToken },
    opts.clientId,
    opts.clientSecret,
    opts.fetcher ?? boundFetch,
  );
  return toTokens(resp, opts.now ?? Date.now(), opts.refreshToken);
}

export function buildFreeagentAuthorizeRedirect(opts: {
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

// Refresh once less than an hour remains — resolution happens at call time,
// so the margin only needs to outlast a single tool call.
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

// Serves access tokens from the vault-loaded set, refreshing on demand.
// onRotate persists every refreshed set (FreeAgent may rotate the refresh
// token, and the new access token is worth keeping across DO hibernation).
export class FreeAgentTokenSource {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private tokens: FreeAgentTokens,
    private onRotate?: (tokens: FreeAgentTokens) => Promise<void>,
    private fetcher: Fetcher = boundFetch,
  ) {}

  async token(): Promise<string> {
    if (Date.now() < this.tokens.expiresAt - REFRESH_MARGIN_MS) return this.tokens.accessToken;
    const refreshed = await refreshFreeagent({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.tokens.refreshToken,
      fetcher: this.fetcher,
    });
    this.tokens = refreshed;
    await this.onRotate?.(refreshed);
    return refreshed.accessToken;
  }
}

export class FreeAgentApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Detail tools take an API URL (FreeAgent's canonical resource identifier).
// The client only ever fetches URLs on the API host — a bearer token must
// never be sent to an arbitrary URL a model supplied.
export function isApiUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.origin === "https://api.freeagent.com" && url.pathname.startsWith("/v2/");
}

function errorMessage(status: number, body: string): string {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const errors = payload.errors ?? payload.error ?? payload.message;
    if (errors !== undefined) return `FreeAgent API error (status ${status}): ${JSON.stringify(errors)}`;
  } catch {
    // fall through — never echo a non-JSON body
  }
  return `FreeAgent API error (status ${status})`;
}

export class FreeAgentClient {
  constructor(
    private tokens: FreeAgentTokenSource | { token(): Promise<string> },
    private fetcher: Fetcher = boundFetch,
    private baseUrl: string = FREEAGENT_BASE_URL,
  ) {}

  async get(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return this.request(url);
  }

  async getUrl(rawUrl: string): Promise<unknown> {
    if (!isApiUrl(rawUrl)) {
      throw new FreeAgentApiError(400, `url must be a FreeAgent API URL under ${FREEAGENT_BASE_URL}/`);
    }
    return this.request(new URL(rawUrl));
  }

  private async request(url: URL): Promise<unknown> {
    const token = await this.tokens.token();
    const response = await this.fetcher(url.toString(), {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new FreeAgentApiError(response.status, errorMessage(response.status, text));
    try {
      return JSON.parse(text);
    } catch {
      throw new FreeAgentApiError(response.status, "unparseable FreeAgent API response");
    }
  }
}

// A client over a fixed access token — used only during the link callback,
// before anything is in the vault.
export function staticClient(accessToken: string, fetcher: Fetcher = boundFetch): FreeAgentClient {
  return new FreeAgentClient({ token: async () => accessToken }, fetcher);
}

// Owner gate: only the configured company may link a FreeAgent account into
// the vault — without this, any FreeAgent user who reaches the manage page's
// owner could still only link the allowlisted company, and a stranger's
// account is rejected outright.
export async function fetchCompanySubdomain(client: FreeAgentClient): Promise<string> {
  const body = (await client.get("/company")) as { company?: { subdomain?: unknown } };
  const subdomain = body?.company?.subdomain;
  return typeof subdomain === "string" ? subdomain : "";
}
