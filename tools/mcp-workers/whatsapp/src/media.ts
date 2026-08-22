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

const MEDIA_HOST = "mmg.whatsapp.net";
const ORIGIN = "https://web.whatsapp.com";

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
    return `https://${host}${descriptor.directPath}`;
  }
  if (descriptor.url) return descriptor.url;
  throw new MediaError("the message has no media URL");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || MEDIA_HOST;
  } catch {
    return MEDIA_HOST;
  }
}

export async function fetchAndDecrypt(
  descriptor: MediaDescriptor,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<DecryptedMedia> {
  if (!descriptor.mediaType) throw new MediaError("this message has no attachment");
  const response = await fetcher(mediaUrl(descriptor), { headers: { Origin: ORIGIN } });
  if (response.status === 404 || response.status === 410) {
    // WhatsApp expires media; only the phone can re-upload it, which needs a
    // live socket asking for it.
    throw new MediaError("WhatsApp has expired this media; it needs re-uploading from the phone", true);
  }
  if (!response.ok) {
    throw new MediaError(`media download failed with HTTP ${response.status}`);
  }
  const file = new Uint8Array(await response.arrayBuffer());
  const bytes = await decryptMedia(file, descriptor);
  return {
    bytes,
    mimeType: descriptor.mimeType ?? "application/octet-stream",
    filename: descriptor.filename,
  };
}
