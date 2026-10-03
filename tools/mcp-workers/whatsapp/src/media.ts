// Fetching and decrypting WhatsApp media with WebCrypto only.
//
// Baileys can do this (`downloadContentFromMessage` does resolve under
// nodejs_compat), but it is the wrong tool here for one concrete reason:
// `downloadEncryptedContent` verifies nothing — not the 10-byte MAC, not
// fileSha256, not fileEncSha256 — it just drops the trailing MAC bytes and
// decrypts. Media arrives from a CDN over a URL anyone can hand us, so the
// integrity checks are the point, not an extra.
//
// The scheme, read off Baileys' `encryptedStream`:
//
//   iv | cipherKey | macKey  = HKDF-SHA256(mediaKey, 112 bytes, info)
//   file                     = enc || mac
//   enc                      = AES-256-CBC(cipherKey, iv, plaintext)   [PKCS#7]
//   mac                      = HMAC-SHA256(macKey, iv || enc)[0..10]
//   fileEncSha256            = SHA-256(enc || mac)     (the whole download)
//   fileSha256               = SHA-256(plaintext)

import { createDecipheriv, createHash, createHmac } from "node:crypto";

const MEDIA_HOST = "mmg.whatsapp.net";
const ORIGIN = "https://web.whatsapp.com";

// `url` and `directPath` come out of the sender's message proto, which nobody
// validates and the media MAC does not cover. Without this, a crafted message
// could point the bridge's fetch at any host it liked.
const ALLOWED_HOST = /(^|\.)whatsapp\.net$/;

// From Baileys' MEDIA_HKDF_KEY_MAPPING; the info string is
// `WhatsApp ${mapping} Keys`.
const HKDF_INFO: Record<string, string> = {
  image: "WhatsApp Image Keys",
  sticker: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  gif: "WhatsApp Video Keys",
  ptv: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  ptt: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
};

export class MediaError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface MediaDescriptor {
  mediaType: string | null;
  url: string | null;
  directPath: string | null;
  mediaKeyB64: string | null;
  fileSha256B64: string | null;
  fileEncSha256B64: string | null;
  fileLength: number | null;
  mimeType: string | null;
  filename: string | null;
}

export interface DecryptedMedia {
  bytes: Uint8Array;
  mimeType: string;
  filename: string | null;
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** iv(16) | cipherKey(32) | macKey(32) from the message's media key. */
export async function expandMediaKey(
  mediaKey: Uint8Array,
  mediaType: string,
): Promise<{ iv: Uint8Array; cipherKey: Uint8Array; macKey: Uint8Array }> {
  const info = HKDF_INFO[mediaType];
  if (!info) throw new MediaError(`unsupported media type "${mediaType}"`);
  const base = await crypto.subtle.importKey("raw", mediaKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      // Baileys' HKDF passes no salt, which HKDF defines as a zero-length one.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    base,
    112 * 8,
  );
  const expanded = new Uint8Array(bits);
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
  };
}

/**
 * Verify and decrypt a downloaded media file. `file` is exactly what the CDN
 * served: ciphertext with the 10-byte MAC appended.
 */
export async function decryptMedia(
  file: Uint8Array,
  descriptor: Pick<MediaDescriptor, "mediaType" | "mediaKeyB64" | "fileSha256B64" | "fileEncSha256B64">,
): Promise<Uint8Array> {
  if (!descriptor.mediaKeyB64) throw new MediaError("the message has no media key");
  if (file.length <= 10) throw new MediaError("media download is too short to contain a MAC");

  const { iv, cipherKey, macKey } = await expandMediaKey(
    fromBase64(descriptor.mediaKeyB64),
    descriptor.mediaType ?? "",
  );

  if (descriptor.fileEncSha256B64) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", file as BufferSource));
    if (!equalBytes(digest, fromBase64(descriptor.fileEncSha256B64))) {
      throw new MediaError("downloaded media does not match fileEncSha256");
    }
  }

  const enc = file.subarray(0, file.length - 10);
  const mac = file.subarray(file.length - 10);
  const macInput = new Uint8Array(iv.length + enc.length);
  macInput.set(iv, 0);
  macInput.set(enc, iv.length);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, macInput as BufferSource));
  if (!equalBytes(expected.subarray(0, 10), mac)) {
    throw new MediaError("media MAC check failed — the download was tampered with or truncated");
  }

  const aesKey = await crypto.subtle.importKey("raw", cipherKey as BufferSource, "AES-CBC", false, [
    "decrypt",
  ]);
  let plaintext: Uint8Array;
  try {
    // WhatsApp pads with PKCS#7, which WebCrypto strips for us.
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, aesKey, enc as BufferSource),
    );
  } catch {
    throw new MediaError("media decryption failed");
  }

  if (descriptor.fileSha256B64) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext as BufferSource));
    if (!equalBytes(digest, fromBase64(descriptor.fileSha256B64))) {
      throw new MediaError("decrypted media does not match fileSha256");
    }
  }
  return plaintext;
}

/** Where the ciphertext lives. directPath wins; `url` is the fallback. */
export function mediaUrl(descriptor: Pick<MediaDescriptor, "url" | "directPath">): string {
  if (descriptor.directPath) {
    const host = descriptor.url ? safeHost(descriptor.url) : MEDIA_HOST;
    // directPath is a path, not a URL: refuse anything that could escape it.
    if (!descriptor.directPath.startsWith("/") || descriptor.directPath.startsWith("//")) {
      throw new MediaError("the message's media path is not a path");
    }
    return `https://${host}${descriptor.directPath}`;
  }
  if (descriptor.url) {
    const host = safeHost(descriptor.url, { strict: true });
    const url = new URL(descriptor.url);
    if (url.protocol !== "https:") throw new MediaError("media URLs must be https");
    return `https://${host}${url.pathname}${url.search}`;
  }
  throw new MediaError("the message has no media URL");
}

function safeHost(url: string, { strict = false }: { strict?: boolean } = {}): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    if (strict) throw new MediaError("the message's media URL is unparseable");
    return MEDIA_HOST;
  }
  if (!host || !ALLOWED_HOST.test(host.split(":")[0] ?? "")) {
    if (strict) throw new MediaError(`refusing to fetch media from ${host || "an empty host"}`);
    return MEDIA_HOST;
  }
  return host;
}

// --- the send side --------------------------------------------------------
//
// Baileys' own upload writes the encrypted file to os.tmpdir() and streams it
// with node:https — neither exists in workerd — so outgoing media is encrypted
// in memory here and POSTed with fetch. The wire format is the same one
// `encryptedStream` produces, because the receiver's client verifies it.

export interface EncryptedUpload {
  /** enc || mac, exactly what gets POSTed and later downloaded. */
  body: Uint8Array;
  mediaKey: Uint8Array;
  fileSha256: Uint8Array;
  fileEncSha256: Uint8Array;
  fileLength: number;
}

export async function encryptForUpload(
  plaintext: Uint8Array,
  mediaType: string,
  mediaKey: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<EncryptedUpload> {
  const { iv, cipherKey, macKey } = await expandMediaKey(mediaKey, mediaType);
  const aesKey = await crypto.subtle.importKey("raw", cipherKey as BufferSource, "AES-CBC", false, [
    "encrypt",
  ]);
  const enc = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, aesKey, plaintext as BufferSource),
  );
  const macInput = new Uint8Array(iv.length + enc.length);
  macInput.set(iv, 0);
  macInput.set(enc, iv.length);
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    macKey as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, macInput as BufferSource)).subarray(
    0,
    10,
  );
  const body = new Uint8Array(enc.length + mac.length);
  body.set(enc, 0);
  body.set(mac, enc.length);
  return {
    body,
    mediaKey,
    fileSha256: new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext as BufferSource)),
    fileEncSha256: new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource)),
    fileLength: plaintext.length,
  };
}

/** WhatsApp's upload URLs use base64url with the padding stripped. */
export function encodeForUpload(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface UploadHost {
  hostname: string;
}

/** POST the ciphertext to a media host and return where it landed. */
export async function uploadEncrypted(
  upload: EncryptedUpload,
  mediaType: string,
  conn: { hosts: UploadHost[]; auth: string },
  pathMap: Record<string, string>,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ url?: string; directPath?: string }> {
  const path = pathMap[mediaType];
  if (path === undefined) throw new MediaError(`cannot upload media of type "${mediaType}"`);
  const token = encodeForUpload(Buffer.from(upload.fileEncSha256).toString("base64"));
  const failures: string[] = [];
  for (const { hostname } of conn.hosts) {
    const url = `https://${hostname}${path}/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`;
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN },
        body: upload.body as BodyInit,
      });
      if (!response.ok) {
        failures.push(`${hostname}: HTTP ${response.status}`);
        continue;
      }
      const result = (await response.json()) as { url?: string; direct_path?: string };
      if (result.url || result.direct_path) {
        return { url: result.url, directPath: result.direct_path };
      }
      failures.push(`${hostname}: ${JSON.stringify(result).slice(0, 120)}`);
    } catch (err) {
      failures.push(`${hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new MediaError(`media upload failed on every host (${failures.join("; ")})`);
}

export interface FetchOptions {
  /** Refuse a download bigger than this, before it is buffered. */
  maxBytes?: number;
  fetcher?: typeof fetch;
}

export async function fetchAndDecrypt(
  descriptor: MediaDescriptor,
  { maxBytes = 16 * 1024 * 1024, fetcher = (input, init) => fetch(input, init) }: FetchOptions = {},
): Promise<DecryptedMedia> {
  if (!descriptor.mediaType) throw new MediaError("this message has no attachment");
  const response = await fetcher(mediaUrl(descriptor), {
    headers: { Origin: ORIGIN },
    // A redirect could otherwise walk off the allowlist.
    redirect: "manual",
  });
  if (response.status === 404 || response.status === 410) {
    // WhatsApp expires media; only the phone can re-upload it, which needs a
    // live socket asking for it.
    throw new MediaError("WhatsApp has expired this media; it needs re-uploading from the phone", true);
  }
  if (!response.ok) {
    throw new MediaError(`media download failed with HTTP ${response.status}`);
  }
  // Decryption transiently holds about three copies of the file against a
  // 128 MB isolate, so the size is checked before anything is buffered.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new MediaError(`attachment is ${Math.round(declared / 1024)} KB, over the limit for this call`);
  }
  const file = new Uint8Array(await response.arrayBuffer());
  if (file.length > maxBytes) {
    throw new MediaError(`attachment is ${Math.round(file.length / 1024)} KB, over the limit for this call`);
  }
  const bytes = await decryptMedia(file, descriptor);
  return {
    bytes,
    mimeType: descriptor.mimeType ?? "application/octet-stream",
    filename: descriptor.filename,
  };
}

// --- streaming download ---------------------------------------------------
//
// `fetchAndDecrypt` buffers, which is right for the inline tools (their caps
// are tiny) and wrong for moving a 40 MB PDF into Drive: decryption holds about
// three copies of the file against a 128 MB isolate. `openDecryptedStream`
// decrypts as the ciphertext arrives instead. WebCrypto has no incremental
// AES-CBC, SHA-256 or HMAC, so this half uses node:crypto, which workerd
// supports in full under nodejs_compat (Cipheriv/Decipheriv, Hash, Hmac).
//
// Streaming means plaintext leaves before the MAC at the end of the file has
// been checked. Two rules keep that honest:
//   - the stream declares its exact size up front (from the message's
//     fileLength, cross-checked against the ciphertext's length), and
//   - the last plaintext bytes are withheld until the MAC, fileEncSha256 and
//     fileSha256 have all passed; any failure errors the stream instead.
// So a consumer that commits only on a complete, correctly sized stream — a
// Drive resumable upload with a declared size is one — never commits a
// tampered or truncated file. A consumer that writes partial bytes somewhere
// durable must discard them when the stream errors.

/**
 * Largest attachment `openDecryptedStream` will stream. Not a memory bound —
 * streaming holds a chunk at a time — but a sanity ceiling matching the
 * gateway's largest file cap, so a runaway download cannot pin the bridge.
 */
export const STREAM_MEDIA_CEILING = 100 * 1024 * 1024;

/**
 * Largest attachment decrypted in memory when it cannot be streamed (the
 * message carries no usable fileLength, so the exact size is unknown until
 * the padding is stripped). Three copies of 32 MB fit a 128 MB isolate with
 * room for the rest of the bridge; 100 MB would not.
 */
export const BUFFERED_MEDIA_CEILING = 32 * 1024 * 1024;

export interface DecryptedStream {
  mimeType: string;
  filename: string | null;
  /** Exact plaintext byte count; the stream errors rather than deliver another. */
  size: number;
  /** A byte stream (`type: "bytes"`), the only kind Workers RPC can carry. */
  body: ReadableStream<Uint8Array>;
  /** False when the file had to be decrypted in memory first. */
  streamed: boolean;
}

export interface StreamOptions {
  /** Ceiling for streamed downloads; defaults to STREAM_MEDIA_CEILING. */
  maxBytes?: number;
  /** Ceiling for the in-memory fallback; defaults to BUFFERED_MEDIA_CEILING. */
  maxBufferedBytes?: number;
  fetcher?: typeof fetch;
}

/** Ciphertext length (enc || mac) for a plaintext of `size` bytes. */
export function encryptedLength(size: number): number {
  // PKCS#7 always pads, by 1..16 bytes.
  return (Math.floor(size / 16) + 1) * 16 + 10;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * A byte stream over `chunks`, copying each into its own ArrayBuffer: byte
 * streams transfer what is enqueued, and node:crypto's small outputs can share
 * a pooled buffer that must not be detached.
 */
function byteStream(
  next: () => Promise<Uint8Array | null>,
  onCancel: (reason: unknown) => Promise<void> | void = () => {},
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    type: "bytes",
    async pull(controller) {
      // Loop until something is enqueued: a byte stream's pull is not called
      // again on its own after a pull that produced nothing.
      for (;;) {
        let chunk: Uint8Array | null;
        try {
          chunk = await next();
        } catch (err) {
          controller.error(err);
          return;
        }
        if (chunk === null) {
          controller.close();
          // A pending BYOB request would otherwise hang the reader.
          controller.byobRequest?.respond(0);
          return;
        }
        if (chunk.length > 0) {
          controller.enqueue(new Uint8Array(chunk));
          return;
        }
      }
    },
    cancel: onCancel,
  }) as ReadableStream<Uint8Array>;
}

/** A byte stream over bytes already in memory, in modest slices. */
function bufferedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const SLICE = 256 * 1024;
  let offset = 0;
  return byteStream(async () => {
    if (offset >= bytes.length) return null;
    const slice = bytes.subarray(offset, offset + SLICE);
    offset += slice.length;
    return slice;
  });
}

function tooBig(bytes: number, limit: number): MediaError {
  return new MediaError(
    `attachment is ${Math.round(bytes / 1024)} KB, over the ${Math.round(limit / (1024 * 1024))} MB limit`,
  );
}

/**
 * Download, verify and decrypt an attachment as a stream. Throws MediaError
 * for anything known before the first byte (no media, expired, too big, a
 * length that contradicts the message); integrity failures found later error
 * the stream instead.
 */
export async function openDecryptedStream(
  descriptor: MediaDescriptor,
  {
    maxBytes = STREAM_MEDIA_CEILING,
    maxBufferedBytes = BUFFERED_MEDIA_CEILING,
    fetcher = (input, init) => fetch(input, init),
  }: StreamOptions = {},
): Promise<DecryptedStream> {
  if (!descriptor.mediaType) throw new MediaError("this message has no attachment");
  if (!descriptor.mediaKeyB64) throw new MediaError("the message has no media key");
  // Validates the type before any network traffic.
  const keys = await expandMediaKey(fromBase64(descriptor.mediaKeyB64), descriptor.mediaType);
  if (descriptor.fileLength !== null && descriptor.fileLength > maxBytes) {
    throw tooBig(descriptor.fileLength, maxBytes);
  }

  const response = await fetcher(mediaUrl(descriptor), {
    headers: { Origin: ORIGIN },
    // A redirect could otherwise walk off the allowlist.
    redirect: "manual",
  });
  if (response.status === 404 || response.status === 410) {
    throw new MediaError("WhatsApp has expired this media; it needs re-uploading from the phone", true);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new MediaError(`media download failed with HTTP ${response.status}`);
  }
  const mimeType = descriptor.mimeType ?? "application/octet-stream";
  const header = response.headers.get("content-length");
  const declared = header === null ? null : Number(header);

  // The size is only knowable up front from fileLength, and only trusted when
  // the CDN's length agrees with it (the MAC does not cover fileLength).
  const size = descriptor.fileLength;
  const streamable =
    size !== null && size >= 0 && (declared === null || declared === encryptedLength(size));
  if (!streamable) {
    const limit = Math.min(maxBytes, maxBufferedBytes);
    if (declared !== null && declared > limit + 26) {
      await response.body.cancel();
      throw tooBig(declared, limit);
    }
    const file = await readCapped(response.body, limit + 26);
    const bytes = await decryptMedia(file, descriptor);
    if (bytes.length > limit) throw tooBig(bytes.length, limit);
    return { mimeType, filename: descriptor.filename, size: bytes.length, body: bufferedStream(bytes), streamed: false };
  }

  const total = encryptedLength(size);
  const reader = response.body.getReader();
  const decipher = createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  const mac = createHmac("sha256", keys.macKey).update(keys.iv);
  const encHash = createHash("sha256");
  const plainHash = createHash("sha256");
  let received = 0;
  let emitted = 0;
  // The trailing 10 bytes seen so far: the MAC, if the file ends here.
  let tail: Uint8Array = new Uint8Array(0);
  // The latest plaintext, held back until more arrives — so the final bytes
  // only leave once verification has passed.
  let pending: Uint8Array = new Uint8Array(0);
  let done = false;

  const release = (chunk: Uint8Array): Uint8Array => {
    const out = pending;
    pending = chunk;
    emitted += out.length;
    return out;
  };

  const finish = (): Uint8Array => {
    if (received !== total) {
      throw new MediaError(`media download ended after ${received} of ${total} bytes`);
    }
    const expectedMac = mac.digest().subarray(0, 10);
    if (!equalBytes(expectedMac, tail)) {
      throw new MediaError("media MAC check failed — the download was tampered with or truncated");
    }
    if (descriptor.fileEncSha256B64 && !equalBytes(encHash.digest(), fromBase64(descriptor.fileEncSha256B64))) {
      throw new MediaError("downloaded media does not match fileEncSha256");
    }
    let final: Uint8Array;
    try {
      // Checks and strips the PKCS#7 padding.
      final = new Uint8Array(decipher.final());
    } catch {
      throw new MediaError("media decryption failed");
    }
    plainHash.update(final);
    const last = concat(pending, final);
    if (descriptor.fileSha256B64 && !equalBytes(plainHash.digest(), fromBase64(descriptor.fileSha256B64))) {
      throw new MediaError("decrypted media does not match fileSha256");
    }
    if (emitted + last.length !== size) {
      throw new MediaError(`decrypted media is ${emitted + last.length} bytes, not the ${size} the message declared`);
    }
    pending = new Uint8Array(0);
    return last;
  };

  const next = async (): Promise<Uint8Array | null> => {
    if (done) return null;
    const { value, done: ended } = await reader.read();
    if (ended) {
      done = true;
      return finish();
    }
    received += value.length;
    if (received > total) {
      await reader.cancel();
      throw new MediaError(`media download is longer than the ${total} bytes the message declared`);
    }
    encHash.update(value);
    const joined = concat(tail, value);
    const cut = Math.max(0, joined.length - 10);
    const enc = joined.subarray(0, cut);
    tail = joined.slice(cut);
    if (enc.length === 0) return new Uint8Array(0);
    mac.update(enc);
    const plain = new Uint8Array(decipher.update(enc));
    if (plain.length === 0) return new Uint8Array(0);
    plainHash.update(plain);
    return release(plain);
  };

  const body = byteStream(
    async () => {
      try {
        return await next();
      } catch (err) {
        done = true;
        await reader.cancel().catch(() => {});
        throw err;
      }
    },
    async (reason) => {
      done = true;
      await reader.cancel(reason);
    },
  );
  return { mimeType, filename: descriptor.filename, size, body, streamed: true };
}

/** Read a body into memory, refusing as soon as it passes `limit` bytes. */
async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw tooBig(length, limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Extensions for the mime types WhatsApp actually sends, so a photo saved to
// Drive opens as one. Anything else gets `.bin` rather than a guess.
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "application/pdf": "pdf",
};

/**
 * The sender's filename when there is one; otherwise one built from the media
 * type and message id, e.g. `whatsapp-image-3EB0ABCD.jpg`. Path separators are
 * replaced, since the name ends up as a Drive or attachment filename.
 */
export function mediaFilename(
  messageId: string,
  mediaType: string | null,
  mimeType: string | null,
  filename: string | null,
): string {
  const given = filename?.trim().replace(/[\\/\u0000-\u001f]/g, "_");
  if (given) return given;
  const bare = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = EXTENSIONS[bare] ?? "bin";
  const id = messageId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `whatsapp-${mediaType ?? "media"}-${id}.${ext}`;
}
