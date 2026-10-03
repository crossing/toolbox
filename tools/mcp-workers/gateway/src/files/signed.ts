// Signed file URLs: https://<gateway>/files/<token>, a bearer credential that
// lets a sandbox with nothing but curl download one file or upload one file,
// without an MCP session.
//
// The token is opaque: base64url(jti) "." base64url(HMAC-SHA256(FILES_URL_KEY,
// TOKEN_CONTEXT + jti)). It carries no user, account, target, size or expiry —
// URLs end up in logs, shells and transcripts, and a self-describing payload
// put the owner's email in every one of them. What a token allows lives
// server-side as a grant {v, userId, account, method, target, maxBytes, exp},
// keyed by jti, in a grant store (http.ts grantStoreFor; SQL below).
//
// The MAC is checked before any store lookup, so a guessed or tampered token
// never costs a Durable Object round trip. TOKEN_CONTEXT separates this MAC
// from every other use of the key, and FILES_URL_KEY is its own secret, so a
// session cookie (crypto.ts signToken, keyed by COOKIE_SECRET) never passes.
//
// `target` names a Drive file id (GET: the file to serve; PUT: the pre-created
// `_Transit` file whose content the upload fills) or an export descriptor —
// never a resumable session URI: http.ts opens the session at request time,
// so no uncapped upload credential is ever stored or handed out.
//
// Expiry and method are checked in verifyToken. Single use for PUT is the
// route's job: it calls the store's claim once the size checks pass.

/** Every file URL lives at most this long. */
export const FILE_URL_TTL_MS = 15 * 60 * 1000;
const VERSION = 2;
/** Domain separation for the MAC; bump with VERSION. */
const TOKEN_CONTEXT = "gateway/files-url/v2:";
/** 16 random bytes and a 32-byte MAC, both unpadded base64url. */
const TOKEN_SHAPE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export type FileUrlMethod = "GET" | "PUT";

export interface FileUrlGrant {
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
}

/** A grant as the store returns it: `used` is set once a PUT has claimed it. */
export interface StoredGrant {
  grant: FileUrlGrant;
  used: boolean;
}

/**
 * Where grants live. Every method takes the caller's clock so tests can move
 * time; an expired grant is never returned and never claimable.
 */
export interface FileGrantStore {
  put(jti: string, grant: FileUrlGrant, now: number): Promise<void>;
  get(jti: string, now: number): Promise<StoredGrant | null>;
  /** Atomically mark a live, unused grant used; true for exactly one caller. */
  claim(jti: string, now: number): Promise<boolean>;
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

export type VerifyResult =
  | { ok: true; jti: string; grant: FileUrlGrant; used: boolean }
  | { ok: false; reason: VerifyFailure };

function requireKey(key: string | undefined): string {
  if (!key) throw new Error("FILES_URL_KEY is not set");
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function macKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Create a grant, store it, and return the opaque token that names it. The
 * grant is stored before the token leaves this function, so a URL is never
 * handed out for a grant the store does not hold.
 */
export async function signToken(
  key: string | undefined,
  store: FileGrantStore,
  request: SignRequest,
  now: () => number = Date.now,
): Promise<{ token: string; jti: string; grant: FileUrlGrant }> {
  const secret = requireKey(key);
  const ttl = request.ttlMs ?? FILE_URL_TTL_MS;
  if (!(ttl > 0 && ttl <= FILE_URL_TTL_MS)) throw new Error(`file URL TTL must be 1..${FILE_URL_TTL_MS} ms`);
  if (!request.userId || !request.target) throw new Error("file URL needs a userId and a target");
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) throw new Error("maxBytes must be a non-negative integer");
  const issuedAt = now();
  const grant: FileUrlGrant = {
    v: VERSION,
    userId: request.userId,
    account: request.account ?? null,
    method: request.method,
    target: request.target,
    maxBytes: request.maxBytes,
    exp: issuedAt + ttl,
  };
  const jti = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", await macKey(secret, "sign"), new TextEncoder().encode(TOKEN_CONTEXT + jti)),
  );
  await store.put(jti, grant, issuedAt);
  return { token: `${jti}.${toBase64Url(mac)}`, jti, grant };
}

function isGrant(value: unknown): value is FileUrlGrant {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === VERSION &&
    typeof p.userId === "string" &&
    (p.account === null || typeof p.account === "string") &&
    (p.method === "GET" || p.method === "PUT") &&
    typeof p.target === "string" &&
    typeof p.maxBytes === "number" &&
    typeof p.exp === "number"
  );
}

/**
 * Check a token for `method`. The MAC check is WebCrypto's HMAC verify, which
 * compares in constant time; the store is consulted only once it passes.
 * A well-signed token whose grant is gone reads as expired: the store drops
 * grants only at expiry, and only this key could have minted the jti.
 * Round-1 tokens (base64 JSON payloads) fail the shape check: malformed.
 */
export async function verifyToken(
  key: string | undefined,
  store: FileGrantStore,
  token: string,
  method: FileUrlMethod,
  now: () => number = Date.now,
): Promise<VerifyResult> {
  const secret = requireKey(key);
  const match = TOKEN_SHAPE.exec(token);
  if (!match) return { ok: false, reason: "malformed" };
  const [, jti = "", macPart = ""] = match;
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await macKey(secret, "verify"),
      fromBase64Url(macPart) as unknown as ArrayBuffer,
      new TextEncoder().encode(TOKEN_CONTEXT + jti),
    );
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid) return { ok: false, reason: "bad-signature" };
  const at = now();
  const stored = await store.get(jti, at);
  if (stored === null) return { ok: false, reason: "expired" };
  if ((stored.grant as { v?: unknown }).v !== VERSION) return { ok: false, reason: "unsupported-version" };
  if (!isGrant(stored.grant)) return { ok: false, reason: "malformed" };
  if (at >= stored.grant.exp) return { ok: false, reason: "expired" };
  if (stored.grant.method !== method) return { ok: false, reason: "wrong-method" };
  return { ok: true, jti, grant: stored.grant, used: stored.used };
}

// ---- the grant table ---------------------------------------------------------
//
// Plain SQL over a Durable Object's SqlStorage (node:sqlite in tests), run
// inside the DO, whose single-threaded execution makes claimGrant's
// check-and-set atomic. Expired rows are deleted on every write and on any
// read that finds one, so the table only ever holds URLs alive right now.

/** The slice of SqlStorage the grant table needs. */
export interface GrantSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const GRANT_SCHEMA = `CREATE TABLE IF NOT EXISTS file_url_grants (
  jti TEXT PRIMARY KEY,
  grant_json TEXT NOT NULL,
  exp INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)`;

export function putGrant(sql: GrantSql, jti: string, grant: FileUrlGrant, now: number): void {
  sql.exec(GRANT_SCHEMA);
  sql.exec("DELETE FROM file_url_grants WHERE exp <= ?", now);
  // A plain INSERT: a jti collision (128 random bits) must fail loudly, not
  // overwrite a live grant.
  sql.exec("INSERT INTO file_url_grants (jti, grant_json, exp) VALUES (?, ?, ?)", jti, JSON.stringify(grant), grant.exp);
}

export function getGrant(sql: GrantSql, jti: string, now: number): StoredGrant | null {
  sql.exec(GRANT_SCHEMA);
  const row = sql.exec("SELECT grant_json, exp, used FROM file_url_grants WHERE jti = ?", jti).toArray()[0];
  if (!row) return null;
  if (Number(row.exp) <= now) {
    sql.exec("DELETE FROM file_url_grants WHERE jti = ?", jti);
    return null;
  }
  try {
    return { grant: JSON.parse(String(row.grant_json)) as FileUrlGrant, used: Number(row.used) === 1 };
  } catch {
    return null;
  }
}

export function claimGrant(sql: GrantSql, jti: string, now: number): boolean {
  sql.exec(GRANT_SCHEMA);
  const rows = sql
    .exec("UPDATE file_url_grants SET used = 1 WHERE jti = ? AND used = 0 AND exp > ? RETURNING jti", jti, now)
    .toArray();
  return rows.length === 1;
}
