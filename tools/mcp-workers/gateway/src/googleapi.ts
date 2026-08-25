// Google API client (ported from gws-mcp's api.ts). Google access tokens
// live ~1 hour, so the session DO refreshes in-process: TokenSource holds the
// current access token in instance memory and re-refreshes from the vault's
// long-lived refresh token on demand (Google does not rotate refresh tokens,
// so nothing needs writing back). A TokenSource built straight from a vault
// blob starts with no access token (expiresAt 0) and refreshes on first use.

import { boundFetch, type Fetcher } from "@toolbox/mcp-shared";
import { refreshUpstream, type UpstreamTokens } from "./google";

const REFRESH_MARGIN_MS = 60 * 1000;

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class TokenSource {
  private accessToken: string;
  private expiresAt: number;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private upstream: UpstreamTokens,
    private fetcher: Fetcher = boundFetch,
  ) {
    this.accessToken = upstream.accessToken;
    this.expiresAt = upstream.expiresAt;
  }

  async token(): Promise<string> {
    if (Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.accessToken;
    const refreshed = await refreshUpstream({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.upstream.refreshToken,
      fetcher: this.fetcher,
    });
    this.accessToken = refreshed.accessToken;
    this.expiresAt = refreshed.expiresAt;
    return this.accessToken;
  }
}

function errorMessage(status: number, body: string): string {
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof payload.error?.message === "string") {
      return `Google API error (status ${status}): ${payload.error.message}`;
    }
  } catch {
    // fall through — never echo a non-JSON body
  }
  return `Google API error (status ${status})`;
}

// An array value becomes a repeated query parameter, which is how Google's APIs
// take multi-valued arguments (`metadataHeaders` on messages.get, for one).
export type QueryParams = Record<string, string | number | boolean | string[] | undefined>;

export class GoogleClient {
  constructor(
    private tokens: TokenSource,
    private fetcher: Fetcher = boundFetch,
  ) {}

  private async doFetch(method: string, url: string, query?: QueryParams, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === "") continue;
      if (Array.isArray(value)) {
        for (const entry of value) u.searchParams.append(key, entry);
      } else {
        u.searchParams.set(key, String(value));
      }
    }
    const token = await this.tokens.token();
    const response = await this.fetcher(u.toString(), {
      ...init,
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new GoogleApiError(response.status, errorMessage(response.status, text));
    }
    return response;
  }

  async getJson(url: string, query?: QueryParams): Promise<unknown> {
    return (await this.doFetch("GET", url, query)).json();
  }

  async getRaw(url: string, query?: QueryParams): Promise<ArrayBuffer> {
    const response = await this.doFetch("GET", url, query, { headers: { accept: "*/*" } });
    return response.arrayBuffer();
  }

  async sendJson(method: "POST" | "PATCH" | "PUT", url: string, body: unknown, query?: QueryParams): Promise<unknown> {
    const response = await this.doFetch(method, url, query, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async sendBody(method: "POST" | "PATCH" | "PUT", url: string, contentType: string, body: string, query?: QueryParams): Promise<unknown> {
    const response = await this.doFetch(method, url, query, {
      headers: { "content-type": contentType },
      body,
    });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async delete(url: string, query?: QueryParams): Promise<void> {
    await this.doFetch("DELETE", url, query);
  }
}
