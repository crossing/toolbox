// Google API client (ported from gws-mcp's api.ts). Google access tokens
// live ~1 hour, so the session DO refreshes in-process: TokenSource holds the
// current access token in instance memory and re-refreshes from the vault's
// long-lived refresh token on demand (Google does not rotate refresh tokens,
// so nothing needs writing back). A TokenSource built straight from a vault
// blob starts with no access token (expiresAt 0) and refreshes on first use.

import { boundFetch, type Fetcher } from "@toolbox/mcp-shared";
import { refreshUpstream, type UpstreamTokens } from "./google";

const REFRESH_MARGIN_MS = 60 * 1000;
const DRIVE_RESUMABLE = "https://www.googleapis.com/upload/drive/v3/files";

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

  /**
   * The response body as a stream, for piping bytes onwards without holding
   * them: a Drive `alt=media` download into a signed GET response or another
   * upload. getRaw stays for callers that need the whole buffer.
   */
  async getStream(url: string, query?: QueryParams): Promise<ReadableStream<Uint8Array>> {
    const response = await this.doFetch("GET", url, query, { headers: { accept: "*/*" } });
    if (!response.body) throw new GoogleApiError(502, "Google API returned an empty body");
    return response.body;
  }

  /**
   * Open a Drive resumable upload session and return its session URI. With
   * `fileId` the session replaces that file's content (PATCH) — how a
   * pre-created `_Transit` placeholder gets its bytes — otherwise it creates a
   * new file from `metadata`. `query` belongs here, not on the upload: the
   * `fields` given now shape the file JSON the final PUT returns.
   *
   * The session URI is itself a credential (no auth header is needed to
   * upload to it), so it never leaves the Worker.
   */
  async startResumableUpload(
    metadata: Record<string, unknown>,
    mimeType: string,
    size?: number,
    options: { fileId?: string; query?: QueryParams } = {},
  ): Promise<string> {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mimeType,
    };
    if (size !== undefined) headers["x-upload-content-length"] = String(size);
    const url = options.fileId ? `${DRIVE_RESUMABLE}/${encodeURIComponent(options.fileId)}` : DRIVE_RESUMABLE;
    const response = await this.doFetch(
      options.fileId ? "PATCH" : "POST",
      url,
      { supportsAllDrives: true, ...options.query, uploadType: "resumable" },
      { headers, body: JSON.stringify(metadata) },
    );
    // Drain so the connection can be reused; the session lives in the header.
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new GoogleApiError(502, "Drive opened no upload session (no Location header)");
    return location;
  }

  /**
   * Send the whole file to a session from startResumableUpload in one PUT,
   * streamed. `size` must be the exact byte count: Drive needs a
   * Content-Length, and in workerd only a FixedLengthStream body carries one
   * (a plain stream goes out chunked). A body that comes up short or long
   * fails the request rather than storing a truncated file.
   */
  async uploadToSession(sessionUri: string, body: ReadableStream<Uint8Array>, size: number): Promise<unknown> {
    let sent: ReadableStream<Uint8Array> = body;
    const init: RequestInit & { duplex?: "half" } = { headers: { "content-length": String(size) } };
    if (typeof FixedLengthStream === "function") {
      const fixed = new FixedLengthStream(size);
      // Not awaited: the fetch below consumes the readable side, and a
      // pipe failure surfaces there as a failed upload.
      void body.pipeTo(fixed.writable).catch(() => {});
      sent = fixed.readable;
    } else {
      // Node's fetch (vitest) wants this for any streamed request body.
      init.duplex = "half";
    }
    const response = await this.doFetch("PUT", sessionUri, undefined, { ...init, body: sent });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
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
