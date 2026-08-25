// RFC 822/2045/2047/2231 message construction for outgoing Gmail drafts.
//
// Everything here is pure and unit-tested: given headers, a body and a list of
// attachments it returns one ASCII string. That the result is *always ASCII* is
// load-bearing — non-ASCII header text becomes RFC 2047 encoded-words and every
// body part is base64 — so the message can be handed to `fetch` as a plain
// string with no byte-level plumbing, whichever of the two upload paths it
// takes (see gmail.ts).
//
// Three details cost real debugging time if you get them wrong, so they are
// spelled out rather than left to a reader's memory of the RFCs:
//
//   - An encoded-word may not exceed 75 characters (RFC 2047 §2). A derived
//     "Re: <subject>" routinely blows past that, so long values are split on
//     character boundaries into several encoded-words folded onto continuation
//     lines.
//   - A non-ASCII filename belongs in RFC 2231 `filename*`, not in an
//     encoded-word — encoded-words are illegal in parameter values, however
//     widely they are tolerated. We emit an ASCII `filename` first for naive
//     parsers and `filename*` after it for everyone else; a compliant reader
//     prefers the extended form regardless of order.
//   - Header values are attacker-influenced. A draft's recipients or subject
//     are routinely assembled from an email the agent just read, and a bare
//     "\r\nBcc: ..." in one of them would inject a header into the message. All
//     header text is stripped of CR/LF before assembly.

const CRLF = "\r\n";

/** Gmail refuses a message over 25 MB, counted *after* base64 expansion. */
export const GMAIL_MESSAGE_BYTE_CAP = 25 * 1024 * 1024;
/** Source bytes that fit under the cap once base64 has added its third. */
export const TOTAL_ATTACHMENT_BYTE_CAP = 18 * 1024 * 1024;
/** Mirrors whatsapp_send_file, for callers pasting bytes inline. */
export const INLINE_ATTACHMENT_BYTE_CAP = 5 * 1024 * 1024;
/** Bounds worst-case Worker memory for one draft. */
export const MAX_ATTACHMENTS = 10;

export function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Chunked so a large attachment cannot overflow the argument stack the way
 * `String.fromCharCode(...bytes)` does somewhere north of 100 kB.
 */
export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * Accepts what a model is likely to send — standard or URL alphabet, with or
 * without padding and stray newlines — and returns canonical base64. Throws on
 * anything that is not base64 at all, so a mistyped argument fails here rather
 * than arriving at the recipient as a corrupt attachment.
 */
export function normalizeBase64(input: string): string {
  const cleaned = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (cleaned === "" || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error("attachment data is not valid base64");
  }
  const unpadded = cleaned.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) throw new Error("attachment data is not valid base64");
  return unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
}

/** Decoded size of canonical base64, without decoding it. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** No CR, LF or NUL may reach a header value. See the injection note above. */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\u0000]/g, " ").replace(/\s+/g, " ").trim();
}

function isAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * RFC 2047 encoded-word, split and folded so no single word exceeds 75 chars.
 * 45 source bytes encode to 60 base64 characters, which with the 12-character
 * `=?UTF-8?B??=` wrapper lands at 72 — inside the limit with room for the
 * leading fold space. Splitting on a 3-byte boundary also keeps each chunk
 * padding-free, and slicing the *encoded* bytes never splits a UTF-8 sequence
 * across words in a way a decoder cannot rejoin.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;
  const bytes = new TextEncoder().encode(value);
  const CHUNK = 45;
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    words.push(`=?UTF-8?B?${bytesToBase64(bytes.subarray(i, i + CHUNK))}?=`);
  }
  return words.join(CRLF + " ");
}

/**
 * Encodes only the display-name half of each address: an addr-spec must stay
 * literal, so `Björn <b@x.com>` becomes `=?UTF-8?B?...?= <b@x.com>` rather than
 * an encoded-word wrapping the whole thing (which would be a syntactically
 * invalid address, silently dropped by some servers).
 */
export function encodeAddressList(value: string): string {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const match = /^(.*?)\s*<([^>]*)>$/.exec(entry);
      if (!match) return entry;
      const name = match[1] ?? "";
      const addr = match[2] ?? "";
      if (name === "") return `<${addr}>`;
      const bare = name.replace(/^"(.*)"$/, "$1");
      return isAscii(bare) ? `${name} <${addr}>` : `${encodeHeaderValue(bare)} <${addr}>`;
    })
    .join(", ");
}

/**
 * Folds a header whose value is a whitespace-separated list. References grows
 * by one msg-id per reply and is regularly kilobytes long on an old thread;
 * unfolded it would breach the 998-octet line limit of RFC 5322 §2.1.1.
 */
export function foldListHeader(name: string, value: string): string {
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return `${name}:`;
  const lines: string[] = [];
  let line = `${name}:`;
  for (const part of parts) {
    if (line.length + 1 + part.length > 76 && line !== `${name}:`) {
      lines.push(line);
      line = " " + part;
    } else {
      line += " " + part;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/** RFC 2045 §6.8: base64 lines are at most 76 characters. */
export function wrapBase64(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join(CRLF);
}

// RFC 2231 attribute-char: everything else is percent-encoded.
function percentEncode(value: string): string {
  const safe = /[A-Za-z0-9!#$&+\-.^_`|~]/;
  return [...new TextEncoder().encode(value)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return safe.test(char) ? char : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    })
    .join("");
}

/**
 * An ASCII fallback plus, when the name needs it, the RFC 2231 extended form.
 * Note that Gmail's own API echoes the *fallback* back in
 * `payload.parts[].filename` even though it stores both parameters verbatim —
 * the recipient still sees the Unicode name, so a round-trip through
 * gmail_get_message showing "r_sum_.pdf" is cosmetic, not a bug.
 */
export function contentDisposition(filename: string): string {
  const clean = sanitizeHeaderValue(filename).replace(/[/\\]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  if (ascii === clean) return `Content-Disposition: attachment; filename="${ascii}"`;
  return [
    "Content-Disposition: attachment;",
    ` filename="${ascii}";`,
    ` filename*=UTF-8''${percentEncode(clean)}`,
  ].join(CRLF);
}

/**
 * Gmail threads a reply only when the Subject matches the parent's, so the
 * default is derived rather than left to the caller. An existing reply prefix
 * is not doubled; prefixes in other languages ("AW:", "SV:") are left alone,
 * because rewriting them is how a subject stops matching its thread.
 */
export function deriveReplySubject(parentSubject: string): string {
  const trimmed = parentSubject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * RFC 2822 §3.6.4: the parent's References followed by the parent's Message-ID,
 * falling back to the Message-ID alone when the parent starts the thread.
 */
export function buildReferences(parentMessageId: string, parentReferences: string): string {
  const chain = `${parentReferences} ${parentMessageId}`.split(/\s+/).filter(Boolean);
  // A malformed thread can repeat an id; keep the first occurrence of each.
  return [...new Set(chain)].join(" ");
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  /** Canonical base64 — run it through normalizeBase64 first. */
  base64: string;
}

export interface MessageOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  attachments?: OutgoingAttachment[];
}

/**
 * Builds the RFC 822 message. With no attachments the output is byte-identical
 * to what this server has always produced (plus threading headers when asked),
 * so existing callers see no change; attachments switch it to multipart/mixed
 * with a base64 text part, which sidesteps 8-bit line-length limits and the
 * bare-LF question in one move.
 */
export function buildMimeMessage(opts: MessageOptions): string {
  const attachments = opts.attachments ?? [];
  const lines = [`To: ${encodeAddressList(sanitizeHeaderValue(opts.to))}`];
  if (opts.cc) lines.push(`Cc: ${encodeAddressList(sanitizeHeaderValue(opts.cc))}`);
  if (opts.bcc) lines.push(`Bcc: ${encodeAddressList(sanitizeHeaderValue(opts.bcc))}`);
  lines.push(`Subject: ${encodeHeaderValue(sanitizeHeaderValue(opts.subject))}`);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`);
  if (opts.references) lines.push(foldListHeader("References", sanitizeHeaderValue(opts.references)));
  lines.push("MIME-Version: 1.0");

  if (attachments.length === 0) {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push("Content-Transfer-Encoding: 8bit");
    return lines.join(CRLF) + CRLF + CRLF + opts.body;
  }

  const boundary = "toolbox-mcp-" + crypto.randomUUID();
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(toBase64Standard(opts.body)),
  ];
  for (const attachment of attachments) {
    parts.push(`--${boundary}`, attachmentPart(attachment));
  }
  parts.push(`--${boundary}--`, "");
  return lines.join(CRLF) + CRLF + CRLF + parts.join(CRLF);
}

function toBase64Standard(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** One MIME part: its headers, a blank line, and the wrapped payload. */
export function attachmentPart(attachment: OutgoingAttachment): string {
  const name = sanitizeHeaderValue(attachment.filename).replace(/[/\\]/g, "_");
  const asciiName = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  return [
    `Content-Type: ${sanitizeHeaderValue(attachment.mimeType)}; name="${asciiName}"`,
    "Content-Transfer-Encoding: base64",
    contentDisposition(attachment.filename),
    "",
    wrapBase64(attachment.base64),
  ].join(CRLF);
}

// ---- adding an attachment to a message that already exists ----
//
// Everything below works on the message as *bytes*, held in a latin1 string so
// one character is one octet. Rebuilding a draft from Gmail's parsed payload
// would be far easier to write and quietly lossy: a real draft is
// multipart/mixed wrapping a multipart/alternative of text/plain and text/html,
// and a rebuild that picks one body would throw the other away, along with any
// header this code did not think to carry over. Splicing preserves every byte
// that was already there, including bodies in encodings we never decode.

export function base64UrlToBytes(data: string): Uint8Array {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Bytes as a latin1 string: one char per octet, no transcoding, reversible. */
export function bytesToLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

export function latin1ToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

// Headers that describe the *content* rather than the message, and so have to
// travel with the body when it is demoted into a part.
const CONTENT_HEADERS =
  /^(content-type|content-transfer-encoding|content-disposition|content-id|content-description|content-language|content-location|content-md5):/i;

export interface MessageShape {
  headerBlock: string;
  body: string;
  /** Top-level boundary, when the message is multipart. */
  boundary?: string;
  /** Only multipart/mixed can take another attachment by insertion. */
  isMixed: boolean;
}

/**
 * Splits a raw message at its first blank line and reads the top-level
 * Content-Type. Nothing nested is parsed — the splice never needs to know.
 */
export function inspectMessage(message: string): MessageShape {
  const match = /\r?\n\r?\n/.exec(message);
  const headerBlock = match ? message.slice(0, match.index) : message;
  const body = match ? message.slice(match.index + match[0].length) : "";
  // Unfold before reading, or a boundary pushed onto a continuation line is missed.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
  const contentType = /^content-type:(.*)$/im.exec(unfolded)?.[1]?.trim() ?? "";
  const boundary = /boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))/i.exec(contentType);
  return {
    headerBlock,
    body,
    boundary: boundary?.[1] ?? boundary?.[2],
    isMixed: /^multipart\/mixed/i.test(contentType),
  };
}

/**
 * Adds one attachment to an existing raw message.
 *
 * multipart/mixed already is a list of parts, so the new one goes in ahead of
 * the closing delimiter and every existing byte is untouched. Anything else —
 * a bare text/plain, or a multipart/alternative whose parts are *alternative
 * representations of one body* and would misread an attachment as a third
 * rendering of it — gets demoted whole into the first part of a new
 * multipart/mixed.
 */
export function addAttachmentToMessage(message: string, attachment: OutgoingAttachment): string {
  const part = attachmentPart(attachment);
  const shape = inspectMessage(message);

  if (shape.isMixed && shape.boundary) {
    const closing = `--${shape.boundary}--`;
    const index = message.lastIndexOf(closing);
    if (index !== -1) {
      return message.slice(0, index) + `--${shape.boundary}${CRLF}${part}${CRLF}` + message.slice(index);
    }
    // A multipart message with no closing delimiter is malformed; fall through
    // and wrap it rather than appending into nothing.
  }

  const boundary = "toolbox-mcp-" + crypto.randomUUID();
  // Split on newlines that do not begin a folded continuation.
  const entries = shape.headerBlock.split(/\r?\n(?![ \t])/).filter((line) => line.trim() !== "");
  const messageHeaders = entries.filter((h) => !CONTENT_HEADERS.test(h) && !/^mime-version:/i.test(h));
  const contentHeaders = entries.filter((h) => CONTENT_HEADERS.test(h));
  if (contentHeaders.length === 0) contentHeaders.push('Content-Type: text/plain; charset="UTF-8"');

  return [
    ...messageHeaders,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...contentHeaders,
    "",
    shape.body.replace(/\r?\n+$/, ""),
    `--${boundary}`,
    part,
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
