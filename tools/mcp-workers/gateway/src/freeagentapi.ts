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

  // Every body these return has been through sanitizeFreeagent: FreeAgent
  // embeds presigned, expiring file URLs in attachment objects, and those
  // must never reach the model. Only openAttachment reads one, internally.

  async get(path: string, params?: Record<string, string | undefined>): Promise<unknown> {
    return sanitizeFreeagent((await this.request("GET", this.pathUrl(path, params))).body);
  }

  /**
   * One page of a list endpoint, with what FreeAgent's pagination headers say
   * about the rest: the Link header's rel="next"/"last" page numbers and
   * X-Total-Count, each null when absent.
   */
  async getPage(path: string, params?: Record<string, string | undefined>): Promise<FreeAgentPage> {
    const { body, headers } = await this.request("GET", this.pathUrl(path, params));
    const links = parseLinkHeader(headers.get("link"));
    const total = Number(headers.get("x-total-count"));
    return {
      body: sanitizeFreeagent(body),
      nextPage: links.next ?? null,
      lastPage: links.last ?? null,
      total: headers.has("x-total-count") && Number.isFinite(total) ? total : null,
    };
  }

  async getUrl(rawUrl: string): Promise<unknown> {
    return sanitizeFreeagent((await this.request("GET", this.apiUrl(rawUrl))).body);
  }

  async postJson(path: string, body: unknown): Promise<unknown> {
    return sanitizeFreeagent((await this.request("POST", new URL(this.baseUrl + path), body)).body);
  }

  // PUT/DELETE take API URLs the model supplied (FreeAgent's canonical
  // resource identifiers), so they go through the same host guard as getUrl.
  async putUrl(rawUrl: string, body: unknown): Promise<unknown> {
    return sanitizeFreeagent((await this.request("PUT", this.apiUrl(rawUrl), body)).body);
  }

  /** An attachment's metadata, sanitized; takes an attachment id or its API URL. */
  async getAttachment(idOrUrl: string): Promise<FreeAgentAttachment> {
    const raw = await this.rawAttachment(attachmentUrl(idOrUrl));
    return sanitizeFreeagent(raw) as FreeAgentAttachment;
  }

  /**
   * An attachment's bytes, streamed. Reads the metadata afresh for a
   * content_src (presigned, about 30 s to live) and fetches it without the
   * bearer token — it is a storage URL, not an API one. Neither the URL nor
   * anything derived from it leaves this method.
   */
  async openAttachment(idOrUrl: string): Promise<{ attachment: FreeAgentAttachment; body: ReadableStream<Uint8Array> }> {
    const url = attachmentUrl(idOrUrl);
    const raw = (await this.rawAttachment(url)) as Record<string, unknown>;
    const src = raw.content_src;
    let parsed: URL | undefined;
    try {
      parsed = typeof src === "string" ? new URL(src) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.protocol !== "https:") {
      throw new FreeAgentApiError(502, "FreeAgent returned no downloadable content for this attachment");
    }
    let response: Response;
    try {
      response = await this.fetcher(parsed.toString(), { method: "GET" });
    } catch {
      throw new FreeAgentApiError(502, "FreeAgent attachment storage unreachable");
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new FreeAgentApiError(
        response.status === 200 ? 502 : response.status,
        `FreeAgent attachment download failed (status ${response.status})`,
      );
    }
    return { attachment: sanitizeFreeagent(raw) as FreeAgentAttachment, body: response.body };
  }

  async deleteAttachment(idOrUrl: string): Promise<{ deleted: true; id: string }> {
    const url = attachmentUrl(idOrUrl);
    await this.request("DELETE", new URL(url));
    return { deleted: true, id: url.slice(url.lastIndexOf("/") + 1) };
  }

  private async rawAttachment(url: string): Promise<Record<string, unknown>> {
    const { body } = await this.request("GET", new URL(url));
    const attachment = (body as { attachment?: unknown })?.attachment;
    if (!attachment || typeof attachment !== "object") {
      throw new FreeAgentApiError(502, "FreeAgent returned no attachment object");
    }
    return attachment as Record<string, unknown>;
  }

  private pathUrl(path: string, params?: Record<string, string | undefined>): URL {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return url;
  }

  async deleteUrl(rawUrl: string): Promise<void> {
    await this.request("DELETE", this.apiUrl(rawUrl));
  }

  private apiUrl(rawUrl: string): URL {
    if (!isApiUrl(rawUrl)) {
      throw new FreeAgentApiError(400, `url must be a FreeAgent API URL under ${FREEAGENT_BASE_URL}/`);
    }
    return new URL(rawUrl);
  }

  private async request(method: string, url: URL, body?: unknown): Promise<{ body: unknown; headers: Headers }> {
    const token = await this.tokens.token();
    const response = await this.fetcher(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new FreeAgentApiError(response.status, errorMessage(response.status, text));
    if (text === "") return { body: {}, headers: response.headers };
    try {
      return { body: JSON.parse(text), headers: response.headers };
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

// ---- pagination -------------------------------------------------------------

export interface FreeAgentPage {
  /** The page's JSON, sanitized. */
  body: unknown;
  /** Link rel="next" page number; null on the last page or when FreeAgent sent no Link header. */
  nextPage: number | null;
  /** Link rel="last" page number, when given. */
  lastPage: number | null;
  /** X-Total-Count, when given. */
  total: number | null;
}

/** Page numbers per rel from an RFC 8288 Link header (`<url?page=2>; rel="next", ...`). */
export function parseLinkHeader(header: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header) return out;
  for (const part of header.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="?([a-z]+)"?/i.exec(part.trim());
    if (!match) continue;
    let page: number;
    try {
      page = Number(new URL(match[1]!).searchParams.get("page") ?? "1");
    } catch {
      continue;
    }
    if (Number.isInteger(page) && page > 0) out[match[2]!.toLowerCase()] = page;
  }
  return out;
}

// ---- sanitizing -------------------------------------------------------------

// Presigned storage URLs (S3 and look-alikes) carry their credential in the
// query string; any string field shaped like one is dropped wherever it is.
const PRESIGNED = /^https?:\/\/[^\s]*[?&](X-Amz-Signature|X-Amz-Credential|Signature|Expires|AWSAccessKeyId|sig|se)=/i;
// Attachment fields that exist only to describe the expiring URLs.
const URL_ONLY_FIELDS = new Set(["expires_at"]);
// Lock state leads each record so a reader sees it before the detail.
const LEADING_FIELDS = ["url", "is_locked", "locked_reason", "locked_attributes"];

export interface FreeAgentAttachment {
  id?: string;
  url?: string;
  file_name?: string;
  content_type?: string;
  file_size?: number;
  description?: string;
  [key: string]: unknown;
}

/**
 * A FreeAgent response made safe to hand to a model: every content_src,
 * content_src_medium and content_src_small removed at any depth, along with
 * any other string that is a presigned URL, and an attachment's expires_at
 * (it dates only those URLs). Attachments gain their numeric `id`; records
 * carrying is_locked list it (and locked_reason) right after `url`.
 */
export function sanitizeFreeagent(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(typeof v === "string" && PRESIGNED.test(v)))
      .map((v) => sanitizeFreeagent(v, key));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const isAttachment = key === "attachment" || key === "attachments" || "content_src" in record;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(record);
  const ordered = [...LEADING_FIELDS.filter((k) => k in record), ...keys.filter((k) => !LEADING_FIELDS.includes(k))];
  if (isAttachment && typeof record.url === "string" && !("id" in record)) {
    const id = /\/attachments\/(\d+)$/.exec(record.url)?.[1];
    if (id) out.id = id;
  }
  for (const k of ordered) {
    const v = record[k];
    if (/^content_src/.test(k)) continue;
    if (isAttachment && URL_ONLY_FIELDS.has(k)) continue;
    if (typeof v === "string" && PRESIGNED.test(v)) continue;
    out[k] = sanitizeFreeagent(v, k);
  }
  return out;
}

const ATTACHMENT_URL = /^https:\/\/api\.freeagent\.com\/v2\/attachments\/(\d{1,20})$/;

/** The API URL for an attachment given its numeric id or that URL itself; anything else is refused. */
export function attachmentUrl(idOrUrl: string): string {
  const trimmed = idOrUrl.trim();
  if (/^\d{1,20}$/.test(trimmed)) return `${FREEAGENT_BASE_URL}/attachments/${trimmed}`;
  if (ATTACHMENT_URL.test(trimmed)) return trimmed;
  throw new FreeAgentApiError(
    400,
    `attachment_id must be a FreeAgent attachment id or its API URL (${FREEAGENT_BASE_URL}/attachments/<id>)`,
  );
}
