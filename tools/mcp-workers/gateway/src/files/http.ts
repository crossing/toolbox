// /files/<token> — the signed-URL endpoint, so a sandbox holding nothing but
// curl can move one file in or out of Drive without an MCP session:
//
//   curl -T report.pdf "$url"     PUT: fill a pre-created `_Transit` file
//   curl -o report.pdf "$url"     GET: download a Drive file
//   curl -sI .../files/healthcheck   204, no token: proves the host is reachable
//
// The token (files/signed.ts) is the whole credential, so this route sits in
// front of the OAuth provider. Beyond the signature it re-checks only what an
// owner would reach for after a leak: the user is still on ALLOWED_EMAILS and
// the Files service is still on (Drive's own toggle is checked with the
// client). Both bite before the PUT claim and before any Drive call, so
// switching Files off kills every URL already issued. What a token binds:
//
//   GET  target = "<driveFileId>" or "<driveFileId>;export=<mime>" for a Google
//        Docs-native file (default export: PDF). maxBytes = the size when
//        signed; a file that has since grown past it is refused.
//   PUT  target = the Drive file id of a placeholder the issuing tool created
//        in `_Transit`. The resumable session is opened here, at request time,
//        against that file — never carried in the token, because a session URI
//        is an uncapped upload credential and token payloads are readable.
//
// PUT is single-use. The marker is a row in the user's vault Durable Object,
// not a KV key: a DO answers check-and-set atomically and consistently, while
// KV is eventually consistent across locations for up to a minute, which is
// exactly the window a replay would use. Rows are pruned on every claim once
// their token has expired, so the table stays at "URLs live right now".
// The claim happens before any bytes move: a failed upload burns the URL, and
// the caller asks for a fresh one rather than this route guessing whether
// Drive kept a partial write.
//
// Every response is no-store and no-referrer (the token is in the path), and
// no error ever echoes the token, a session URI, or a Google error body. The
// path does still reach Cloudflare's Workers Logs, which record each request
// URL; docs/mcp-workers-infra.md records that as a known exposure.

import type { Fetcher } from "@toolbox/mcp-shared";
import { decryptJson, importVaultKey } from "../crypto";
import { vaultFor, type Env } from "../env";
import { emailAllowed } from "../google";
import { GoogleApiError, GoogleClient, TokenSource } from "../googleapi";
import type { VaultBlob } from "../manage";
import { GOOGLE_ACCOUNT_SERVICE, SERVICES } from "../registry";
import { NoLinkedAccountError, ServiceDisabledError } from "../toolutil";
import { formatRef } from "./refs";
import { verifyToken, type FileUrlMethod, type FileUrlPayload, type VerifyFailure } from "./signed";
import { FILE_CAPS, FileError } from "./types";

export const FILES_PREFIX = "/files/";
const HEALTHCHECK = "healthcheck";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
/** What a Docs-native file downloads as when the target names no format. */
const DEFAULT_EXPORT_MIME = "application/pdf";
const FILE_FIELDS = "id,name,mimeType,size,md5Checksum";

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The public URL for a token; the issuing tools build URLs with this. */
export function fileUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}${FILES_PREFIX}${token}`;
}

/** A GET target, in the grammar this route parses. */
export function fileUrlTarget(fileId: string, exportMime?: string): string {
  return exportMime ? `${fileId};export=${exportMime}` : fileId;
}

function parseGetTarget(target: string): { fileId: string; exportMime?: string } {
  const [fileId = "", ...rest] = target.split(";");
  const option = rest.join(";");
  if (!fileId) throw new FileError(400, "file URL names no file");
  if (!option) return { fileId };
  const match = /^export=(.+)$/.exec(option);
  if (!match) throw new FileError(400, "file URL target is not understood");
  return { fileId, exportMime: match[1] };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

function fail(status: number, error: string, extra?: Record<string, string>): Response {
  return json(status, { error }, extra);
}

const VERIFY_STATUS: Record<VerifyFailure, [number, string]> = {
  malformed: [403, "file URL is not valid"],
  "bad-signature": [403, "file URL is not valid"],
  "unsupported-version": [403, "file URL is not valid"],
  expired: [410, "file URL has expired; ask for a new one"],
  "wrong-method": [405, "file URL does not allow this method"],
};

// ---- single-use markers ----------------------------------------------------

/** The slice of SqlStorage the claim table needs; node:sqlite fits in tests. */
export interface ClaimSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const CLAIM_SCHEMA = `CREATE TABLE IF NOT EXISTS file_url_claims (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)`;

/**
 * Record `jti` as used; true the first time, false on every later sight.
 * Runs inside the vault DO, whose single thread makes it atomic.
 */
export function claimFileUrl(sql: ClaimSql, jti: string, exp: number, now: number = Date.now()): boolean {
  sql.exec(CLAIM_SCHEMA);
  sql.exec("DELETE FROM file_url_claims WHERE exp < ?", now);
  const rows = sql
    .exec("INSERT INTO file_url_claims (jti, exp) VALUES (?, ?) ON CONFLICT (jti) DO NOTHING RETURNING jti", jti, exp)
    .toArray();
  return rows.length === 1;
}

// ---- Google client outside a session -----------------------------------------

/**
 * The Google client for `service` as `email`, outside any MCP session: the
 * same checks ctx.googleClient makes in index.ts (service enabled, account
 * pin, then the namespace default), without its per-session token cache —
 * a signed URL or a cron run is one request, so one refresh is the cost.
 */
export async function googleClientForUser(
  env: Env,
  email: string,
  service: string,
  account?: string,
  fetcher?: Fetcher,
): Promise<GoogleClient> {
  const vault = vaultFor(env, email);
  const def = SERVICES.find((svc) => svc.id === service);
  if (!(await vault.isServiceEnabled(service, def?.defaultEnabled ?? false))) throw new ServiceDisabledError(service);
  const acct = await vault.getAccountForService(GOOGLE_ACCOUNT_SERVICE, service, account);
  if (!acct) throw new NoLinkedAccountError(service, account);
  const key = await importVaultKey(env.VAULT_KEY);
  const blob = await decryptJson<VaultBlob>(key, acct.ciphertext);
  const source = new TokenSource(
    env.GWS_CLIENT_ID,
    env.GWS_CLIENT_SECRET,
    { accessToken: "", refreshToken: blob.refreshToken, expiresAt: 0 },
    fetcher,
  );
  return new GoogleClient(source, fetcher);
}

// ---- the route ----------------------------------------------------------------

export interface FilesDeps {
  /** Overrides the network for the Google calls; tests script it. */
  fetcher?: Fetcher;
  now?: () => number;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  md5Checksum?: string;
}

/** RFC 6266: a plain ASCII fallback, plus RFC 5987 `filename*` when the name needs it. */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n"\\]/g, "_") || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  if (ascii === clean) return `attachment; filename="${ascii}"`;
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function driveClient(env: Env, payload: FileUrlPayload, deps: FilesDeps): Promise<GoogleClient> {
  return googleClientForUser(env, payload.userId, "drive", payload.account ?? undefined, deps.fetcher);
}

async function driveMeta(client: GoogleClient, fileId: string): Promise<DriveFile> {
  return (await client.getJson(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  })) as DriveFile;
}

async function handleGet(env: Env, payload: FileUrlPayload, deps: FilesDeps, headOnly: boolean): Promise<Response> {
  const { fileId, exportMime } = parseGetTarget(payload.target);
  const client = await driveClient(env, payload, deps);
  const meta = await driveMeta(client, fileId);
  const native = (meta.mimeType ?? "").startsWith("application/vnd.google-apps.");
  const name = meta.name ?? fileId;
  const headers: Record<string, string> = { ...BASE_HEADERS, "content-disposition": contentDisposition(name) };

  if (native || exportMime) {
    // Exports have no size until Drive renders them, so no Content-Length
    // and no maxBytes check; Drive itself caps an export at 10 MB.
    const mime = exportMime ?? DEFAULT_EXPORT_MIME;
    headers["content-type"] = mime;
    if (headOnly) return new Response(null, { status: 200, headers });
    const body = await client.getStream(`${DRIVE_FILES}/${encodeURIComponent(fileId)}/export`, { mimeType: mime });
    return new Response(body, { status: 200, headers });
  }

  const size = Number(meta.size ?? "0");
  if (size > payload.maxBytes) {
    throw new FileError(409, `file is ${size} bytes, larger than the ${payload.maxBytes} it had when this URL was issued`);
  }
  headers["content-type"] = meta.mimeType || "application/octet-stream";
  headers["content-length"] = String(size);
  if (headOnly) return new Response(null, { status: 200, headers });
  const body = await client.getStream(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    alt: "media",
    supportsAllDrives: true,
  });
  return new Response(body, { status: 200, headers });
}

async function handlePut(request: Request, env: Env, payload: FileUrlPayload, deps: FilesDeps): Promise<Response> {
  // Size first, before the URL is spent: a client that forgot Content-Length
  // (chunked upload) or picked the wrong file can retry with the same URL.
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) {
    return fail(411, "Content-Length is required (curl -T sends it; chunked uploads are not accepted)");
  }
  const size = Number(declared);
  const limit = Math.min(payload.maxBytes, FILE_CAPS.signedPut);
  if (size > limit) return fail(413, `upload is ${size} bytes; this URL accepts at most ${limit}`);

  const claimed = await vaultFor(env, payload.userId).claimFileUrl(payload.jti, payload.exp);
  if (!claimed) return fail(410, "file URL has already been used; ask for a new one");

  const client = await driveClient(env, payload, deps);
  const fileId = payload.target;
  const meta = await driveMeta(client, fileId);
  const session = await client.startResumableUpload({}, meta.mimeType || "application/octet-stream", size, {
    fileId,
    query: { fields: FILE_FIELDS },
  });
  const body = request.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const uploaded = (await client.uploadToSession(session, body, size)) as DriveFile;
  const ref = formatRef({ kind: "drive", fileId, ...(payload.account !== null && { account: payload.account }) });
  return json(200, {
    ref,
    name: uploaded.name ?? meta.name,
    mimeType: uploaded.mimeType ?? meta.mimeType,
    size: uploaded.size !== undefined ? Number(uploaded.size) : size,
    ...(uploaded.md5Checksum && { md5: uploaded.md5Checksum }),
  });
}

/** Map a failure to a status and a message that is safe to show. */
function errorResponse(err: unknown): Response {
  if (err instanceof FileError) return fail(err.status, err.message);
  if (err instanceof ServiceDisabledError || err instanceof NoLinkedAccountError) return fail(403, err.message);
  if (err instanceof GoogleApiError) {
    // Status only: Google's messages can quote request URLs, and a resumable
    // session URL is a credential.
    if (err.status === 404) return fail(404, "file not found in Drive (deleted, or not visible to the linked account)");
    return fail(502, `Drive refused the request (status ${err.status})`);
  }
  return fail(500, "file transfer failed");
}

/**
 * Returns null when the path is not under /files/, so the caller falls
 * through to its other routes.
 */
export async function handleFilesRequest(request: Request, env: Env, deps: FilesDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(FILES_PREFIX)) return null;
  const token = url.pathname.slice(FILES_PREFIX.length);
  const method = request.method.toUpperCase();

  if (token === HEALTHCHECK) {
    if (method !== "GET" && method !== "HEAD") return fail(405, "method not allowed", { allow: "GET, HEAD" });
    return new Response(null, { status: 204, headers: BASE_HEADERS });
  }
  if (!token || token.includes("/")) return fail(404, "not found");

  let verifyAs: FileUrlMethod;
  if (method === "GET" || method === "HEAD") verifyAs = "GET";
  else if (method === "PUT") verifyAs = "PUT";
  else return fail(405, "method not allowed", { allow: "GET, HEAD, PUT" });

  if (!env.FILES_URL_KEY) return fail(503, "file URLs are not configured on this gateway");
  const verified = await verifyToken(env.FILES_URL_KEY, token, verifyAs, deps.now);
  if (!verified.ok) {
    const [status, message] = VERIFY_STATUS[verified.reason];
    return fail(status, message, verified.reason === "wrong-method" ? { allow: verifyAs === "GET" ? "PUT" : "GET, HEAD" } : {});
  }

  try {
    // Revocation: an owner who pulls an email or switches Files off after a
    // leak expects issued URLs to stop now, not at their expiry.
    const payload = verified.payload;
    if (!emailAllowed(payload.userId, env.ALLOWED_EMAILS ?? "")) return fail(403, "file URL is not valid");
    const filesDef = SERVICES.find((svc) => svc.id === "files");
    if (!(await vaultFor(env, payload.userId).isServiceEnabled("files", filesDef?.defaultEnabled ?? true))) {
      throw new ServiceDisabledError("files");
    }
    return verifyAs === "PUT"
      ? await handlePut(request, env, verified.payload, deps)
      : await handleGet(env, verified.payload, deps, method === "HEAD");
  } catch (err) {
    return errorResponse(err);
  }
}
