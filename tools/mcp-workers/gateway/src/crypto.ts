// Key material plumbing for the gateway: AES-GCM for vault blobs (upstream
// refresh tokens at rest) and HMAC-signed compact tokens for the management
// session cookie and OAuth state. Pure WebCrypto so it runs identically in
// workerd and in vitest under Node.
//
// The vault DO stores only ciphertext and never sees VAULT_KEY; encryption
// and decryption happen in the worker/session code that holds the env.

function toBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return toBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export async function importVaultKey(base64Key: string): Promise<CryptoKey> {
  const raw = toBytes(base64Key.trim());
  if (raw.byteLength !== 32) throw new Error("VAULT_KEY must be 32 bytes of base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
}

export async function decryptJson<T>(key: CryptoKey, blob: string): Promise<T> {
  const [ivPart, ctPart] = blob.split(".");
  if (!ivPart || !ctPart) throw new Error("malformed vault blob");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivPart) },
    key,
    fromBase64Url(ctPart),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

async function hmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

// Compact signed token: base64url(JSON payload) + "." + base64url(HMAC).
// Expiry lives inside the payload; callers check it after verification.
export async function signToken(secret: string, payload: unknown): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${toBase64Url(mac)}`;
}

export async function verifyToken<T>(secret: string, token: string): Promise<T | null> {
  const [body, macPart] = token.split(".");
  if (!body || !macPart) return null;
  const key = await hmacKey(secret, ["verify"]);
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(macPart) as unknown as ArrayBuffer,
      new TextEncoder().encode(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
  } catch {
    return null;
  }
}

export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
