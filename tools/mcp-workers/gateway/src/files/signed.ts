// Signed file URLs: https://<gateway>/files/<token>, a bearer credential that
// lets a sandbox with nothing but curl download one file or upload one file,
// without an MCP session. The token is the compact HMAC form crypto.ts uses
// for cookies — base64url(JSON payload) "." base64url(HMAC-SHA256) — keyed by
// its own secret, FILES_URL_KEY, so a cookie can never pass as a file URL.
//
// The payload is signed, not encrypted: anyone holding the URL can read it.
// So `target` names a Drive file id (GET: the file to serve; PUT: the
// pre-created `_Transit` file whose content the upload fills) or an opaque
// descriptor — never a resumable session URI, which would be a second, uncapped
// credential for the same upload.
//
// Expiry and method are checked here. Single use for PUT is the route's job:
// it records `jti` once the upload starts and refuses a second sight of it.

import { signToken as hmacSign, verifyToken as hmacVerify } from "../crypto";

/** Every file URL lives at most this long. */
export const FILE_URL_TTL_MS = 15 * 60 * 1000;
const VERSION = 1;

export type FileUrlMethod = "GET" | "PUT";

export interface FileUrlPayload {
  v: typeof VERSION;
  /** The gateway identity (normalized email) whose vault holds the credentials. */
  userId: string;
  /** Linked-account label for the Drive call; null is the default account. */
  account: string | null;
  method: FileUrlMethod;
  target: string;
  /** PUT: the largest body accepted. GET: the size the file had when signed. */
  maxBytes: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
  /** Random id; the single-use marker for PUT. */
  jti: string;
}

export interface SignRequest {
  userId: string;
  account?: string | null;
  method: FileUrlMethod;
  target: string;
  maxBytes: number;
  /** Defaults to, and may not exceed, FILE_URL_TTL_MS. */
  ttlMs?: number;
}

export type VerifyFailure = "malformed" | "bad-signature" | "unsupported-version" | "expired" | "wrong-method";

export type VerifyResult = { ok: true; payload: FileUrlPayload } | { ok: false; reason: VerifyFailure };

function requireKey(key: string | undefined): string {
  if (!key) throw new Error("FILES_URL_KEY is not set");
  return key;
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signToken(
  key: string | undefined,
  request: SignRequest,
  now: () => number = Date.now,
): Promise<{ token: string; payload: FileUrlPayload }> {
  const ttl = request.ttlMs ?? FILE_URL_TTL_MS;
  if (!(ttl > 0 && ttl <= FILE_URL_TTL_MS)) throw new Error(`file URL TTL must be 1..${FILE_URL_TTL_MS} ms`);
  if (!request.userId || !request.target) throw new Error("file URL needs a userId and a target");
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");
  const payload: FileUrlPayload = {
    v: VERSION,
    userId: request.userId,
    account: request.account ?? null,
    method: request.method,
    target: request.target,
    maxBytes: request.maxBytes,
    exp: now() + ttl,
    jti: randomId(),
  };
  return { token: await hmacSign(requireKey(key), payload), payload };
}

function isPayload(value: unknown): value is FileUrlPayload {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.userId === "string" &&
    (p.account === null || typeof p.account === "string") &&
    (p.method === "GET" || p.method === "PUT") &&
    typeof p.target === "string" &&
    typeof p.maxBytes === "number" &&
    typeof p.exp === "number" &&
    typeof p.jti === "string"
  );
}

/**
 * Check a token for `method`. The signature check is WebCrypto's HMAC
 * verify, which compares in constant time; nothing in the payload is trusted
 * until it passes.
 */
export async function verifyToken(
  key: string | undefined,
  token: string,
  method: FileUrlMethod,
  now: () => number = Date.now,
): Promise<VerifyResult> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, reason: "malformed" };
  const payload = await hmacVerify<unknown>(requireKey(key), token);
  if (payload === null) return { ok: false, reason: "bad-signature" };
  if ((payload as { v?: unknown }).v !== VERSION) return { ok: false, reason: "unsupported-version" };
  if (!isPayload(payload)) return { ok: false, reason: "malformed" };
  if (now() >= payload.exp) return { ok: false, reason: "expired" };
  if (payload.method !== method) return { ok: false, reason: "wrong-method" };
  return { ok: true, payload };
}
