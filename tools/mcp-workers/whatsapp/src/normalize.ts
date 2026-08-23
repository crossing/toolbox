// Turning Baileys' WAMessage into the row shape the store (and therefore the
// MCP tools) expects. Kept apart from the socket so it can be unit-tested
// without a connection.

import { extractMessageContent, getContentType, jidNormalizedUser, toNumber } from "baileys";
import type { WAMessage } from "baileys";
import type { StoredMessage } from "./store";

/** WhatsApp media protos all carry these; the store keeps them for downloads. */
interface MediaLike {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
  fileEncSha256?: Uint8Array | null;
  fileLength?: number | { toNumber(): number } | null;
  mimetype?: string | null;
  fileName?: string | null;
  caption?: string | null;
}

const MEDIA_KINDS: Record<string, string> = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "sticker",
  ptvMessage: "video",
};

function b64(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes || bytes.length === 0) return null;
  return Buffer.from(bytes).toString("base64");
}

export function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * The text a human would say the message "is": the body for text messages,
 * the caption for captioned media, and nothing for a bare attachment.
 */
export function textOf(message: WAMessage): string | null {
  const content = extractMessageContent(message.message ?? undefined);
  if (!content) return null;
  const media = content as Record<string, MediaLike | undefined>;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    media.imageMessage?.caption ??
    media.videoMessage?.caption ??
    media.documentMessage?.caption ??
    null
  );
}

/** null for a text-only message; otherwise "image" | "video" | … */
export function mediaKindOf(message: WAMessage): string | null {
  const content = extractMessageContent(message.message ?? undefined);
  if (!content) return null;
  const type = getContentType(content);
  return (type && MEDIA_KINDS[type]) ?? null;
}

export function toStoredMessage(message: WAMessage, meId: string | null): StoredMessage | null {
  const chatJid = message.key?.remoteJid;
  const id = message.key?.id;
  if (!chatJid || !id) return null;

  const content = extractMessageContent(message.message ?? undefined);
  const type = content ? getContentType(content) : undefined;
  const mediaType = (type && MEDIA_KINDS[type]) ?? null;
  const media = (type && content ? ((content as Record<string, unknown>)[type] as MediaLike) : null) ?? null;
  const fromMe = Boolean(message.key?.fromMe);

  // In a group the sender is the participant; in a 1:1 chat it is the other
  // end of the chat, or us. Mirrors the Go bridge's sender column.
  const sender = fromMe
    ? jidNormalizedUser(meId ?? "") || (meId ?? "")
    : jidNormalizedUser(message.key?.participant ?? message.participant ?? chatJid);

  const fileLength =
    media?.fileLength == null
      ? null
      : typeof media.fileLength === "number"
        ? media.fileLength
        : Number(media.fileLength.toNumber());

  return {
    id,
    chatJid,
    sender,
    senderName: message.pushName ?? null,
    content: textOf(message),
    timestamp: isoFromSeconds(toNumber(message.messageTimestamp) || 0),
    isFromMe: fromMe,
    mediaType,
    filename: media?.fileName ?? null,
    url: media?.url ?? null,
    mediaKeyB64: b64(media?.mediaKey),
    fileSha256B64: b64(media?.fileSha256),
    fileEncSha256B64: b64(media?.fileEncSha256),
    fileLength,
    directPath: media?.directPath ?? null,
    mimeType: media?.mimetype ?? null,
  };
}

/** A phone number or an already-qualified JID → a JID WhatsApp will accept. */
export function toJid(recipient: string): string {
  const trimmed = recipient.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length < 8) {
    throw new Error(`"${recipient}" is not a chat JID or an international phone number`);
  }
  return `${digits}@s.whatsapp.net`;
}

/**
 * The name to file a chat under. WhatsApp only tells us the pushName of the
 * person who wrote, so a 1:1 chat is named after them and our own messages
 * teach us nothing.
 */
export function chatNameFor(message: WAMessage): string | null {
  if (message.key?.fromMe) return null;
  if (message.key?.remoteJid?.endsWith("@g.us")) return null;
  return message.pushName ?? null;
}

// WhatsApp needs to be told which kind of attachment this is, and its clients
// key their preview off the mime type, so both are inferred from the filename
// when the caller does not say.
const EXTENSION_KINDS: Record<string, string> = {
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", heic: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video",
  ogg: "audio", opus: "audio", mp3: "audio", m4a: "audio", wav: "audio", aac: "audio",
};

const EXTENSION_MIMES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  ogg: "audio/ogg; codecs=opus", opus: "audio/ogg; codecs=opus", mp3: "audio/mpeg",
  m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", json: "application/json",
  zip: "application/zip", doc: "application/msword", xls: "application/vnd.ms-excel",
};

function extensionOf(filename: string): string {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() ?? "") : "";
}

export function kindFromFilename(filename: string): string {
  return EXTENSION_KINDS[extensionOf(filename)] ?? "document";
}

export function mimeFromFilename(filename: string, kind: string): string {
  const known = EXTENSION_MIMES[extensionOf(filename)];
  if (known) return known;
  return kind === "document" ? "application/octet-stream" : `${kind}/*`;
}
