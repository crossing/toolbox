// Turning Baileys' WAMessage into the row shape the store (and therefore the
// MCP tools) expects. Kept apart from the socket so it can be unit-tested
// without a connection.

import { extractMessageContent, getContentType, jidNormalizedUser, proto, toNumber } from "baileys";
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

/**
 * Who wrote a group message, as a phone-number JID whenever WhatsApp told us
 * one. Groups are increasingly LID-addressed: `key.participant` is then an
 * opaque `…@lid`, and Baileys puts the number in `key.participantAlt`
 * (Utils/decode-wa-message.js). Filing the LID would record *a* sender while
 * losing the one the rest of the store knows them by — `sender_phone_number`
 * filters, contact search and get_contact_chats all key on the number. The LID
 * is kept only when it is all there is.
 */
function groupSenderOf(message: WAMessage): string | null {
  const participant = message.key?.participant || message.participant || null;
  const alt = (message.key as { participantAlt?: string | null } | undefined)?.participantAlt || null;
  if (participant?.endsWith("@lid") && alt?.endsWith("@s.whatsapp.net")) return alt;
  return participant ?? alt;
}

/** An inbound "delete for everyone", reduced to what the store needs. */
export interface InboundRevoke {
  chatJid: string;
  /** The id of the message being withdrawn — not the id of the revoke itself. */
  messageId: string;
  revokedBy: string | null;
  revokedAt: string;
}

/**
 * A revoke is delivered as an ordinary message whose whole content is a
 * `protocolMessage` of type REVOKE naming another message's key. Baileys also
 * announces it on `messages.update` (Utils/process-message.js), but the upsert
 * is the path every drain already flows through. The chat is taken from the
 * envelope, as Baileys does, not from the inner key: in a 1:1 chat the inner
 * `remoteJid` is written from the sender's point of view.
 */
export function revokeOf(message: WAMessage, meId: string | null): InboundRevoke | null {
  const protocol = extractMessageContent(message.message ?? undefined)?.protocolMessage;
  if (!protocol || protocol.type !== proto.Message.ProtocolMessage.Type.REVOKE) return null;
  const chatJid = message.key?.remoteJid;
  const messageId = protocol.key?.id;
  if (!chatJid || !messageId) return null;
  const by = message.key?.fromMe ? meId : (groupSenderOf(message) ?? chatJid);
  return {
    chatJid,
    messageId,
    revokedBy: by ? jidNormalizedUser(by) || by : null,
    revokedAt: isoFromSeconds(toNumber(message.messageTimestamp) || Math.floor(Date.now() / 1000)),
  };
}

export function toStoredMessage(message: WAMessage, meId: string | null): StoredMessage | null {
  const chatJid = message.key?.remoteJid;
  const id = message.key?.id;
  if (!chatJid || !id) return null;

  const content = extractMessageContent(message.message ?? undefined);
  // Protocol messages are plumbing — revokes, edits, key shares, history-sync
  // notices, disappearing-message settings. None is something anyone said, and
  // filed as a row each would be an empty message under an id of its own. A
  // revoke in particular must land on the row it withdraws (revokeOf), not
  // beside it.
  if (content?.protocolMessage) return null;

  const StubType = proto.WebMessageInfo.StubType;
  // The other half of an inbound revoke. When the original and its revoke sit
  // in the same event buffer — the ordinary case for something sent and
  // withdrawn while the bridge was offline — Baileys folds the revoke into the
  // original (Utils/event-buffer.js, `Object.assign(existing, update)`), and
  // what comes out is the original with `message: null`, this stub type, and
  // its key *replaced by the revoke's*. Its content is gone and its id is
  // wrong; the revoke's own upsert carries the right id, and revokeOf files
  // the tombstone under that.
  if (message.messageStubType === StubType.REVOKE && !content) return null;

  // Delivered, but not readable: decryption failed, and Baileys has already
  // asked the sender's phone to send it again. Filed as what it is rather than
  // as an empty message, so "he wrote and the bridge could not read it" is
  // visible in whatsapp_list_messages instead of indistinguishable from
  // nothing having arrived.
  const decryptError =
    message.messageStubType === StubType.CIPHERTEXT
      ? (message.messageStubParameters?.[0] ?? "decryption failed").slice(0, 300)
      : null;
  const type = content ? getContentType(content) : undefined;
  const mediaType = (type && MEDIA_KINDS[type]) ?? null;
  const media = (type && content ? ((content as Record<string, unknown>)[type] as MediaLike) : null) ?? null;
  const fromMe = Boolean(message.key?.fromMe);

  // In a group the sender is the participant; in a 1:1 chat it is the other
  // end of the chat, or us. Mirrors the Go bridge's sender column.
  const sender = fromMe
    ? jidNormalizedUser(meId ?? "") || (meId ?? "")
    : jidNormalizedUser(groupSenderOf(message) ?? chatJid);

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
    // The key as WhatsApp addressed it, which `sender` deliberately is not.
    participant: fromMe || !chatJid.endsWith("@g.us") ? null : (message.key?.participant ?? null),
    decryptError,
  };
}

function bytes(b64Value: string | null | undefined): Uint8Array | undefined {
  return b64Value ? new Uint8Array(Buffer.from(b64Value, "base64")) : undefined;
}

/**
 * One of our own stored messages, rebuilt as the proto a recipient's device is
 * asking to be sent again (see `getMessage` in session.ts). The store keeps
 * rows, not protos, so this is a reconstruction: a text comes back as a plain
 * conversation, and an attachment from the descriptors kept for downloads —
 * the same ciphertext on WhatsApp's CDN, the same key, so nothing is
 * re-uploaded. A revoked message is not resent, and neither is anything that
 * cannot be rebuilt whole.
 */
export function messageForRetry(row: (StoredMessage & { revokedAt?: string | null }) | null): proto.IMessage | undefined {
  if (!row || !row.isFromMe || row.revokedAt) return undefined;
  if (!row.mediaType) return row.content ? { conversation: row.content } : undefined;

  const mediaKey = bytes(row.mediaKeyB64);
  if (!mediaKey || !row.directPath) return undefined;
  const descriptor = {
    url: row.url ?? undefined,
    directPath: row.directPath,
    mediaKey,
    mimetype: row.mimeType ?? undefined,
    fileSha256: bytes(row.fileSha256B64),
    fileEncSha256: bytes(row.fileEncSha256B64),
    fileLength: row.fileLength ?? undefined,
  };
  const caption = row.content ?? undefined;
  switch (row.mediaType) {
    case "image":
      return { imageMessage: { ...descriptor, caption } };
    case "video":
      return { videoMessage: { ...descriptor, caption } };
    case "audio":
      return { audioMessage: { ...descriptor, ptt: false } };
    case "document":
      return { documentMessage: { ...descriptor, fileName: row.filename ?? undefined, caption } };
    default:
      return undefined;
  }
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
