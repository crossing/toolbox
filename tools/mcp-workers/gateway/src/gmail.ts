// Gmail tool surface (ported from gws-mcp, plus the gateway's `account`
// parameter on every tool). Read tools need only gmail.readonly on the
// linked account; write tools are registered solely for write-scope grants
// and need an account linked with write scopes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchDriveAttachment, multipartBody } from "./drive";
import { partialFileContext } from "./files/sources";
import { transfer } from "./files/transfer";
import { GoogleApiError, type GoogleClient } from "./googleapi";
import {
  addAttachmentToMessage,
  base64ByteLength,
  base64UrlToBytes,
  buildMimeMessage,
  buildReferences,
  bytesToLatin1,
  deriveReplySubject,
  encodeAddressList,
  encodeHeaderValue,
  GMAIL_MESSAGE_BYTE_CAP,
  INLINE_ATTACHMENT_BYTE_CAP,
  latin1ToBytes,
  MAX_ATTACHMENTS,
  normalizeBase64,
  removeAttachments,
  replaceMessageBody,
  sanitizeHeaderValue,
  setMessageHeaders,
  toBase64Url,
  TOTAL_ATTACHMENT_BYTE_CAP,
  type HeaderEdit,
  type OutgoingAttachment,
} from "./mime";
import { ACCOUNT_PARAM, DESTRUCTIVE, needsConfirm, READ_ONLY, run, WRITE } from "./toolutil";

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
// The media-upload host. drafts.create accepts a Draft metadata part alongside
// a message/rfc822 media part here, which is how an attachment-bearing draft
// avoids base64url-ing the whole message a second time into a JSON field.
export const GMAIL_UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const BODY_CHAR_CAP = 20000;
const ATTACHMENT_BYTE_CAP = 1_000_000;

// Resolves (optional account label) → an authenticated client; the resolver
// also enforces service enablement, so every tool call fails closed.
export type GetClient = (account?: string) => Promise<GoogleClient>;

// ---- pure helpers (unit-tested) ----

// Message construction lives in mime.ts; re-exported so the Gmail module stays
// the single import site for callers and tests.
export { buildMimeMessage, encodeHeaderValue, toBase64Url } from "./mime";

export function decodeBase64UrlText(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const found = (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

export interface ParsedPayload {
  body: string;
  bodyMimeType: string;
  attachments: { filename: string; mimeType: string; attachmentId: string; size: number }[];
}

export function parsePayload(payload: GmailPart | undefined): ParsedPayload {
  const attachments: ParsedPayload["attachments"] = [];
  let plain = "";
  let html = "";

  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size ?? 0,
      });
    } else if (part.body?.data) {
      if (part.mimeType === "text/plain" && !plain) plain = decodeBase64UrlText(part.body.data);
      else if (part.mimeType === "text/html" && !html) html = decodeBase64UrlText(part.body.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  let body = plain || html;
  let bodyMimeType = plain ? "text/plain" : html ? "text/html" : "";
  if (body.length > BODY_CHAR_CAP) body = body.slice(0, BODY_CHAR_CAP) + "\n…[truncated]";
  return { body, bodyMimeType, attachments };
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

function summarize(msg: GmailMessage, withBody: boolean) {
  const headers = msg.payload?.headers;
  const base = {
    id: msg.id,
    threadId: msg.threadId,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    labelIds: msg.labelIds,
    snippet: msg.snippet,
  };
  if (!withBody) return base;
  const parsed = parsePayload(msg.payload);
  return { ...base, cc: headerValue(headers, "Cc"), body: parsed.body, bodyMimeType: parsed.bodyMimeType, attachments: parsed.attachments };
}

// ---- tool registration ----

export function registerGmailReadTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "gmail_search",
    {
      description:
        "Search Gmail messages with the standard Gmail query syntax (from:, to:, subject:, newer_than:, has:attachment, …). Returns message summaries.",
      inputSchema: {
        query: z.string().describe("Gmail search query"),
        max_results: z.number().int().min(1).max(20).optional().describe("Default 10"),
        account: ACCOUNT_PARAM,
      },
      annotations: READ_ONLY,
    },
    async ({ query, max_results, account }) =>
      run(async () => {
        const client = await getClient(account);
        const list = (await client.getJson(`${GMAIL}/messages`, {
          q: query,
          maxResults: max_results ?? 10,
        })) as { messages?: { id: string }[]; resultSizeEstimate?: number };
        const summaries = [];
        for (const ref of list.messages ?? []) {
          const msg = (await client.getJson(`${GMAIL}/messages/${ref.id}`, {
            format: "metadata",
          })) as GmailMessage;
          summaries.push(summarize(msg, false));
        }
        return { resultSizeEstimate: list.resultSizeEstimate, messages: summaries };
      }),
  );

  server.registerTool(
    "gmail_get_message",
    {
      description: "Fetch one Gmail message: headers, decoded body (text preferred), attachment list.",
      inputSchema: { message_id: z.string(), account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ message_id, account }) =>
      run(async () => {
        const client = await getClient(account);
        const msg = (await client.getJson(`${GMAIL}/messages/${message_id}`, { format: "full" })) as GmailMessage;
        return summarize(msg, true);
      }),
  );

  server.registerTool(
    "gmail_get_thread",
    {
      description: "Fetch a Gmail thread with every message parsed (bodies capped).",
      inputSchema: { thread_id: z.string(), account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ thread_id, account }) =>
      run(async () => {
        const client = await getClient(account);
        const thread = (await client.getJson(`${GMAIL}/threads/${thread_id}`, { format: "full" })) as {
          id?: string;
          messages?: GmailMessage[];
        };
        return { id: thread.id, messages: (thread.messages ?? []).map((m) => summarize(m, true)) };
      }),
  );

  server.registerTool(
    "gmail_list_labels",
    {
      description: "List Gmail labels (system and user).",
      inputSchema: { account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ account }) => run(async () => (await getClient(account)).getJson(`${GMAIL}/labels`)),
  );

  server.registerTool(
    "gmail_list_drafts",
    {
      description: "List Gmail drafts.",
      inputSchema: {
        max_results: z.number().int().min(1).max(50).optional().describe("Default 20"),
        account: ACCOUNT_PARAM,
      },
      annotations: READ_ONLY,
    },
    async ({ max_results, account }) =>
      run(async () => (await getClient(account)).getJson(`${GMAIL}/drafts`, { maxResults: max_results ?? 20 })),
  );

  server.registerTool(
    "gmail_get_attachment",
    {
      description:
        "Download one attachment (find message_id and attachment_id via gmail_get_message). Returns base64 data; capped at ~1MB.",
      inputSchema: { message_id: z.string(), attachment_id: z.string(), account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ message_id, attachment_id, account }) =>
      run(async () => {
        const client = await getClient(account);
        const att = (await client.getJson(`${GMAIL}/messages/${message_id}/attachments/${attachment_id}`)) as {
          size?: number;
          data?: string;
        };
        if ((att.size ?? 0) > ATTACHMENT_BYTE_CAP) {
          throw new GoogleApiError(413, `attachment is ${att.size} bytes; cap is ${ATTACHMENT_BYTE_CAP}`);
        }
        // Gmail returns base64url; hand back standard base64.
        const data = (att.data ?? "").replace(/-/g, "+").replace(/_/g, "/");
        return { size: att.size ?? 0, base64: data };
      }),
  );
}

/**
 * Reads the parent's threading headers. Fetched with format=metadata and an
 * explicit header list so replying to a message with a megabyte body does not
 * drag the body across the wire for three header values.
 */
async function fetchParentHeaders(client: GoogleClient, messageId: string) {
  let msg: GmailMessage;
  try {
    msg = (await client.getJson(`${GMAIL}/messages/${messageId}`, {
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject"],
    })) as GmailMessage;
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      // Gmail's own 404 is a bare "Requested entity was not found", which says
      // neither which id nor which mailbox.
      throw new GoogleApiError(
        404,
        `in_reply_to_message_id "${messageId}" was not found in this mailbox. Message ids are per-account — ` +
          "take one from gmail_search or gmail_get_message on the same account you are drafting from.",
      );
    }
    throw err;
  }
  const headers = msg.payload?.headers;
  return {
    threadId: msg.threadId,
    messageId: headerValue(headers, "Message-ID"),
    references: headerValue(headers, "References"),
    subject: headerValue(headers, "Subject"),
  };
}

// ---- attaching to an existing draft ----
//
// Shared by gmail_attach_drive_file and the file layer's gmail:draft/ sink, so
// both splice into the stored raw message the same way and refuse at the same
// size.

export interface DraftForAttach {
  /** The stored message, exactly as Gmail holds it (format=raw, decoded). */
  existing: Uint8Array;
  threadId?: string;
}

export async function loadDraftForAttach(client: GoogleClient, draftId: string): Promise<DraftForAttach> {
  // format=raw returns the message exactly as stored, which is the only
  // representation that survives being written back.
  let draft: { id?: string; message?: { raw?: string; threadId?: string } };
  try {
    draft = (await client.getJson(`${GMAIL}/drafts/${draftId}`, { format: "raw" })) as typeof draft;
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 404) {
      throw new GoogleApiError(
        404,
        `draft "${draftId}" was not found in this mailbox. Draft ids come from gmail_list_drafts and are ` +
          "not message ids — a message id from gmail_search will not work here.",
      );
    }
    throw err;
  }
  const raw = draft.message?.raw;
  if (!raw) throw new GoogleApiError(404, `draft "${draftId}" has no message body to attach to`);
  return { existing: base64UrlToBytes(raw), threadId: draft.message?.threadId };
}

/** Source bytes the draft can still take: what the message can grow by, before base64 adds its third. */
export function draftAttachRoom(draft: DraftForAttach): number {
  return Math.max(0, Math.floor(((GMAIL_MESSAGE_BYTE_CAP - draft.existing.byteLength) * 3) / 4));
}

export async function saveDraftWithAttachment(
  client: GoogleClient,
  draftId: string,
  draft: DraftForAttach,
  attachment: OutgoingAttachment,
): Promise<{ result: Record<string, unknown>; messageBytes: number }> {
  const updated = addAttachmentToMessage(bytesToLatin1(draft.existing), attachment);
  return saveDraftMessage(client, draftId, draft.threadId, latin1ToBytes(updated));
}

/**
 * Writes a whole message back over a draft. Goes to the media-upload host so a
 * draft carrying megabytes of attachments is not base64url-ed into JSON, and
 * always passes the thread id — a drafts.update without it lifts the draft out
 * of its thread.
 */
async function saveDraftMessage(
  client: GoogleClient,
  draftId: string,
  threadId: string | undefined,
  bytes: Uint8Array,
): Promise<{ result: Record<string, unknown>; messageBytes: number }> {
  if (bytes.byteLength > GMAIL_MESSAGE_BYTE_CAP) {
    throw new GoogleApiError(
      413,
      `the draft would grow to about ${Math.round(bytes.byteLength / 1024 / 1024)} MB; Gmail refuses a message ` +
        "over 25 MB. Send a Drive link in the body instead.",
    );
  }
  const { contentType, body } = multipartBody(threadId ? { message: { threadId } } : {}, {
    text: bytesToLatin1(bytes),
    mimeType: "message/rfc822",
  });
  const result = (await client.sendBody("PUT", `${GMAIL_UPLOAD}/drafts/${draftId}`, contentType, body, {
    uploadType: "multipart",
  })) as Record<string, unknown>;
  return { result, messageBytes: bytes.byteLength };
}

// ---- outgoing attachments, shared by create and update ----

const INLINE_ATTACHMENTS = z.array(
  z.object({
    filename: z.string().describe("Name the recipient sees; non-ASCII is fine"),
    mime_type: z.string().describe("e.g. application/pdf"),
    base64: z.string().describe("File contents, base64-encoded (about 5 MB max, but see the description)"),
  }),
);

const DRIVE_ATTACHMENTS = z.array(
  z.object({
    file_id: z.string().describe("Drive file id, from drive_search"),
    filename: z.string().optional().describe("Override the name the recipient sees"),
    export_mime_type: z
      .string()
      .optional()
      .describe("Export format for Google-native files; defaults to PDF for Docs/Slides, xlsx for Sheets"),
  }),
);

type InlineAttachment = z.infer<typeof INLINE_ATTACHMENTS>[number];
type DriveAttachment = z.infer<typeof DRIVE_ATTACHMENTS>[number];

/**
 * Validates inline attachments and fetches Drive ones, in that order, each
 * Drive fetch capped at what is left of `budget`. The caller checks the total
 * against its own ceiling, which differs between a new draft and an old one.
 */
async function buildAttachments(
  inline: InlineAttachment[],
  fromDrive: DriveAttachment[],
  opts: { getDrive: () => Promise<GoogleClient>; driveAccount?: string; budget: number; driveParam: string },
): Promise<{ built: OutgoingAttachment[]; totalBytes: number }> {
  const built: OutgoingAttachment[] = [];
  let totalBytes = 0;
  for (const item of inline) {
    let base64: string;
    try {
      base64 = normalizeBase64(item.base64);
    } catch {
      throw new GoogleApiError(400, `attachment "${item.filename}" is not valid base64`);
    }
    const bytes = base64ByteLength(base64);
    if (bytes > INLINE_ATTACHMENT_BYTE_CAP) {
      throw new GoogleApiError(
        413,
        `"${item.filename}" is ${bytes} bytes; inline attachments cap at ${INLINE_ATTACHMENT_BYTE_CAP}. ` +
          `Put it in Drive and use ${opts.driveParam} instead.`,
      );
    }
    totalBytes += bytes;
    built.push({ filename: item.filename, mimeType: item.mime_type, base64 });
  }
  if (fromDrive.length > 0) {
    // Resolved lazily: a gateway with Drive switched off keeps a working
    // draft tool and only fails on this path.
    const drive = await opts.getDrive();
    const accountHint = opts.driveAccount ? `the "${opts.driveAccount}" Drive account` : "the default Drive account";
    for (const item of fromDrive) {
      const fetched = await fetchDriveAttachment(drive, item.file_id, {
        accountHint,
        filename: item.filename,
        exportMimeType: item.export_mime_type,
        // What is left of the budget after everything attached so far,
        // never negative — a spent budget must read as "0 bytes left"
        // rather than as a nonsense cap in the refusal message.
        byteCap: Math.max(0, opts.budget - totalBytes),
      });
      totalBytes += fetched.bytes;
      built.push({ filename: fetched.filename, mimeType: fetched.mimeType, base64: fetched.base64 });
    }
  }
  return { built, totalBytes };
}

export function registerGmailWriteTools(
  server: McpServer,
  getClient: GetClient,
  getDriveClient: GetClient,
): void {
  server.registerTool(
    "gmail_create_draft",
    {
      description:
        "Create a Gmail draft, optionally as a reply inside an existing thread and optionally with attachments. Never sends — drafts are reviewed and sent by the human.\n\n" +
        "REPLIES: pass in_reply_to_message_id (from gmail_search or gmail_get_message) and the gateway reads that message's Message-ID and References itself and sets the In-Reply-To/References headers and the thread id. Do not build those headers yourself. Leave `subject` out on a reply — Gmail only threads when the subject matches the parent's, so the default 'Re: <parent subject>' is the one that works.\n\n" +
        "ATTACHMENTS, two ways. `drive_attachments` is the one to reach for: give it Drive file ids and the gateway fetches the bytes with the Drive account's credentials and attaches them with the mail account's, so nothing passes through this conversation — no context cost, and files far larger than you could paste. Google Docs/Sheets/Slides are exported automatically (PDF, xlsx). `attachments` takes base64 inline and is for bytes you hold right here and nowhere else; it costs roughly 0.7 tokens per byte to send, so anything past a few hundred KB belongs in Drive first (drive_create_file) and then in drive_attachments. Gmail refuses a message over 25 MB once encoded, which is about 18 MB of files.",
      inputSchema: {
        to: z.string().describe("Comma-separated recipients"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z
          .string()
          .optional()
          .describe("Required unless in_reply_to_message_id is given, where it defaults to 'Re: <parent subject>'"),
        body: z.string(),
        thread_id: z
          .string()
          .optional()
          .describe("Gmail thread id to file the draft under; inferred from in_reply_to_message_id when that is given"),
        in_reply_to_message_id: z
          .string()
          .optional()
          .describe("Message id being replied to; its threading headers and subject are read by the gateway"),
        attachments: INLINE_ATTACHMENTS
          .optional()
          .describe("Files whose bytes you already hold. Prefer drive_attachments for anything sizeable."),
        drive_attachments: DRIVE_ATTACHMENTS
          .optional()
          .describe("Drive files to attach server-side, without their bytes entering this conversation"),
        account: ACCOUNT_PARAM,
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({
      to,
      cc,
      bcc,
      subject,
      body,
      thread_id,
      in_reply_to_message_id,
      attachments,
      drive_attachments,
      account,
      drive_account,
    }) =>
      run(async () => {
        const client = await getClient(account);

        // Threading first: a bad parent id must fail before anything is
        // created, so a mistake never leaves a half-formed draft behind.
        let threadId = thread_id;
        let inReplyTo: string | undefined;
        let references: string | undefined;
        let resolvedSubject = subject;
        if (in_reply_to_message_id) {
          const parent = await fetchParentHeaders(client, in_reply_to_message_id);
          if (thread_id && parent.threadId && thread_id !== parent.threadId) {
            throw new GoogleApiError(
              400,
              `thread_id "${thread_id}" is not the thread of in_reply_to_message_id "${in_reply_to_message_id}" ` +
                `(that message is in thread "${parent.threadId}"). Pass one or the other.`,
            );
          }
          threadId = thread_id ?? parent.threadId;
          if (parent.messageId) {
            inReplyTo = parent.messageId;
            references = buildReferences(parent.messageId, parent.references);
          }
          if (resolvedSubject === undefined && parent.subject) {
            resolvedSubject = deriveReplySubject(parent.subject);
          }
        }
        if (resolvedSubject === undefined) {
          throw new GoogleApiError(400, "subject is required unless in_reply_to_message_id is given");
        }

        const inline = attachments ?? [];
        const fromDrive = drive_attachments ?? [];
        if (inline.length + fromDrive.length > MAX_ATTACHMENTS) {
          throw new GoogleApiError(400, `at most ${MAX_ATTACHMENTS} attachments per draft`);
        }

        const { built, totalBytes } = await buildAttachments(inline, fromDrive, {
          getDrive: () => getDriveClient(drive_account),
          driveAccount: drive_account,
          budget: TOTAL_ATTACHMENT_BYTE_CAP,
          driveParam: "drive_attachments",
        });
        if (totalBytes > TOTAL_ATTACHMENT_BYTE_CAP) {
          throw new GoogleApiError(
            413,
            `attachments total about ${Math.round(totalBytes / 1024 / 1024)} MB; Gmail refuses a message over 25 MB ` +
              "once base64 has expanded it, so roughly 18 MB of files is the ceiling. Send a Drive link in the body instead.",
          );
        }

        const message = buildMimeMessage({
          to,
          cc,
          bcc,
          subject: resolvedSubject,
          body,
          inReplyTo,
          references,
          attachments: built,
        });

        const summary = {
          threadId,
          attachments: built.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
          attachmentBytes: totalBytes,
        };
        if (built.length === 0) {
          const draft = (await client.sendJson("POST", `${GMAIL}/drafts`, {
            message: { raw: toBase64Url(message), threadId },
          })) as Record<string, unknown>;
          return { ...draft, ...summary };
        }
        // Media upload: the metadata part carries threadId, the media part the
        // message itself, which saves base64url-ing megabytes into a JSON field.
        const { contentType, body: multipart } = multipartBody(
          threadId ? { message: { threadId } } : {},
          { text: message, mimeType: "message/rfc822" },
        );
        const draft = (await client.sendBody("POST", `${GMAIL_UPLOAD}/drafts`, contentType, multipart, {
          uploadType: "multipart",
        })) as Record<string, unknown>;
        return { ...draft, ...summary };
      }),
  );

  server.registerTool(
    "gmail_attach_drive_file",
    {
      description:
        "Deprecated: prefer file_transfer (from drive:<file_id> to gmail:draft/<draft_id>). " +
        "Attach a Drive file to a draft that already exists, without the bytes passing through this conversation — the gateway fetches the file with the Drive account's credentials and attaches it with the mail account's. The exact inverse of drive_save_gmail_attachment, and the way to finish a draft you (or the human) already wrote: no re-typing the body, no downloading and re-uploading, no Gmail UI. Google Docs/Sheets/Slides are exported on the way out (PDF, xlsx). The draft's existing body and attachments are preserved as-is, including HTML formatting. Find draft_id with gmail_list_drafts, file_id with drive_search. To create a draft and attach in one step, use gmail_create_draft's drive_attachments instead. Never sends.",
      inputSchema: {
        draft_id: z.string().describe("Draft id from gmail_list_drafts (not the message id)"),
        file_id: z.string().describe("Drive file id, from drive_search"),
        filename: z.string().optional().describe("Override the name the recipient sees"),
        export_mime_type: z
          .string()
          .optional()
          .describe("Export format for Google-native files; defaults to PDF for Docs/Slides, xlsx for Sheets"),
        account: ACCOUNT_PARAM,
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ draft_id, file_id, filename, export_mime_type, account, drive_account }) =>
      run(async () => {
        // A thin delegation to the file layer; the gmail:draft/ sink splices
        // with the helpers above, and refuses on the draft's room before the
        // Drive download starts.
        const moved = await transfer(
          { kind: "drive", fileId: file_id, ...(drive_account !== undefined && { account: drive_account }) },
          { kind: "gmail-draft", draftId: draft_id, ...(account !== undefined && { account }) },
          partialFileContext({ gmail: getClient, drive: getDriveClient }),
          {
            ...(filename !== undefined && { name: filename }),
            ...(export_mime_type !== undefined && { exportMimeType: export_mime_type }),
          },
        );
        return {
          ...((moved.result ?? {}) as Record<string, unknown>),
          attached: { filename: moved.name, mimeType: moved.mimeType, bytes: moved.size },
        };
      }),
  );

  server.registerTool(
    "gmail_update_draft",
    {
      description:
        "Amend a draft that already exists — recipients, subject, body, and attachments added or removed — in place, keeping the same draft id. Never sends.\n\n" +
        "Only what you pass changes. Everything else in the stored message is kept byte for byte: other attachments, the In-Reply-To/References threading headers, the thread itself. Pass an empty string for cc or bcc to remove them. `body` replaces the whole body with plain text, including an HTML body written in the Gmail UI, so read the draft first (gmail_get_message on its message id) and send the full revised text, not a diff. Changing the subject of a reply can stop Gmail threading it.\n\n" +
        "ATTACHMENTS: `remove_attachments` takes filenames exactly as gmail_get_message lists them for the draft's message; every name must match or nothing is changed. Removals happen before additions, so replacing a file is one call. `add_drive_attachments` relays Drive files server-side with no bytes passing through this conversation and is the one to reach for; `add_attachments` takes base64 inline for bytes you hold only here. Gmail caps the whole message at 25 MB once encoded.\n\n" +
        "Find draft_id with gmail_list_drafts.",
      inputSchema: {
        draft_id: z.string().describe("Draft id from gmail_list_drafts (not the message id)"),
        to: z.string().optional().describe("Comma-separated recipients; replaces the current To"),
        cc: z.string().optional().describe("Replaces the current Cc; empty string removes it"),
        bcc: z.string().optional().describe("Replaces the current Bcc; empty string removes it"),
        subject: z.string().optional(),
        body: z.string().optional().describe("New plain-text body; replaces the current one in full"),
        remove_attachments: z
          .array(z.string())
          .optional()
          .describe("Filenames of attachments to drop, as gmail_get_message lists them"),
        add_attachments: INLINE_ATTACHMENTS.optional().describe(
          "Files whose bytes you already hold. Prefer add_drive_attachments for anything sizeable.",
        ),
        add_drive_attachments: DRIVE_ATTACHMENTS.optional().describe(
          "Drive files to attach server-side, without their bytes entering this conversation",
        ),
        account: ACCOUNT_PARAM,
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({
      draft_id,
      to,
      cc,
      bcc,
      subject,
      body,
      remove_attachments,
      add_attachments,
      add_drive_attachments,
      account,
      drive_account,
    }) =>
      run(async () => {
        if (to !== undefined && sanitizeHeaderValue(to) === "") {
          throw new GoogleApiError(400, "to cannot be empty; a draft needs a recipient");
        }
        const edits: HeaderEdit[] = [];
        const address = (name: string, value: string | undefined) => {
          if (value === undefined) return;
          const clean = sanitizeHeaderValue(value);
          edits.push({ name, value: clean === "" ? null : encodeAddressList(clean) });
        };
        address("To", to);
        address("Cc", cc);
        address("Bcc", bcc);
        if (subject !== undefined) {
          edits.push({ name: "Subject", value: encodeHeaderValue(sanitizeHeaderValue(subject)) });
        }
        const toRemove = remove_attachments ?? [];
        const inline = add_attachments ?? [];
        const fromDrive = add_drive_attachments ?? [];
        if (edits.length === 0 && body === undefined && toRemove.length + inline.length + fromDrive.length === 0) {
          throw new GoogleApiError(
            400,
            "nothing to change: pass at least one of to, cc, bcc, subject, body, remove_attachments, add_attachments, add_drive_attachments",
          );
        }
        if (inline.length + fromDrive.length > MAX_ATTACHMENTS) {
          throw new GoogleApiError(400, `at most ${MAX_ATTACHMENTS} attachments per call`);
        }

        const client = await getClient(account);
        const draft = await loadDraftForAttach(client, draft_id);
        let message = bytesToLatin1(draft.existing);
        if (edits.length > 0) message = setMessageHeaders(message, edits);
        // The body goes in after the header edits, and its new text is base64,
        // so the latin1 round-trip stays exact.
        if (body !== undefined) message = replaceMessageBody(message, body);

        let removed: string[] = [];
        if (toRemove.length > 0) {
          const result = removeAttachments(message, toRemove);
          // All or nothing: a half-applied removal list is worse than none.
          if (result.missing.length > 0) {
            throw new GoogleApiError(
              404,
              `no attachment named ${result.missing.map((n) => `"${n}"`).join(", ")} on draft "${draft_id}". ` +
                "Use the filenames gmail_get_message lists for the draft's message. Nothing was changed.",
            );
          }
          message = result.message;
          removed = result.removed;
        }

        // Fetched only once everything else has been checked, so a bad
        // filename above never costs a Drive download.
        const room = Math.max(0, Math.floor(((GMAIL_MESSAGE_BYTE_CAP - message.length) * 3) / 4));
        const { built, totalBytes } = await buildAttachments(inline, fromDrive, {
          getDrive: () => getDriveClient(drive_account),
          driveAccount: drive_account,
          budget: room,
          driveParam: "add_drive_attachments",
        });
        if (totalBytes > room) {
          throw new GoogleApiError(
            413,
            `the new attachments total about ${Math.round(totalBytes / 1024 / 1024)} MB and the draft has room for about ` +
              `${Math.round(room / 1024 / 1024)} MB under Gmail's 25 MB message cap. Send a Drive link in the body instead.`,
          );
        }
        for (const attachment of built) message = addAttachmentToMessage(message, attachment);

        const { result, messageBytes } = await saveDraftMessage(client, draft_id, draft.threadId, latin1ToBytes(message));
        return {
          ...result,
          threadId: draft.threadId,
          updated: [...edits.map((e) => e.name.toLowerCase()), ...(body !== undefined ? ["body"] : [])],
          removedAttachments: removed,
          addedAttachments: built.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
          messageBytes,
        };
      }),
  );

  server.registerTool(
    "gmail_modify_labels",
    {
      description: "Add/remove labels on a message (archive = remove INBOX, mark read = remove UNREAD).",
      inputSchema: {
        message_id: z.string(),
        add_label_ids: z.array(z.string()).optional(),
        remove_label_ids: z.array(z.string()).optional(),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ message_id, add_label_ids, remove_label_ids, account }) =>
      run(async () =>
        (await getClient(account)).sendJson("POST", `${GMAIL}/messages/${message_id}/modify`, {
          addLabelIds: add_label_ids ?? [],
          removeLabelIds: remove_label_ids ?? [],
        }),
      ),
  );

  server.registerTool(
    "gmail_create_label",
    {
      description: "Create a Gmail label.",
      inputSchema: { name: z.string(), account: ACCOUNT_PARAM },
      annotations: WRITE,
    },
    async ({ name, account }) =>
      run(async () => (await getClient(account)).sendJson("POST", `${GMAIL}/labels`, { name })),
  );

  server.registerTool(
    "gmail_update_label",
    {
      description: "Rename a Gmail label.",
      inputSchema: { label_id: z.string(), name: z.string(), account: ACCOUNT_PARAM },
      annotations: WRITE,
    },
    async ({ label_id, name, account }) =>
      run(async () => (await getClient(account)).sendJson("PATCH", `${GMAIL}/labels/${label_id}`, { name })),
  );

  server.registerTool(
    "gmail_delete_label",
    {
      description: "Delete a Gmail label (messages keep their other labels). Requires confirm: true.",
      inputSchema: { label_id: z.string(), confirm: z.boolean().optional(), account: ACCOUNT_PARAM },
      annotations: DESTRUCTIVE,
    },
    async ({ label_id, confirm, account }) => {
      if (confirm !== true) return needsConfirm();
      return run(async () => {
        await (await getClient(account)).delete(`${GMAIL}/labels/${label_id}`);
        return { deleted: label_id };
      });
    },
  );

  server.registerTool(
    "gmail_list_filters",
    {
      // Registered with the write tools because it needs settings.basic,
      // which only write-scope links request.
      description: "List Gmail filters.",
      inputSchema: { account: ACCOUNT_PARAM },
      annotations: READ_ONLY,
    },
    async ({ account }) => run(async () => (await getClient(account)).getJson(`${GMAIL}/settings/filters`)),
  );

  server.registerTool(
    "gmail_create_filter",
    {
      description:
        "Create a Gmail filter. Criteria: any of from/to/subject/query. Actions: add/remove label ids (e.g. remove INBOX to archive).",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        query: z.string().optional().describe("Gmail search-syntax criteria"),
        add_label_ids: z.array(z.string()).optional(),
        remove_label_ids: z.array(z.string()).optional(),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ from, to, subject, query, add_label_ids, remove_label_ids, account }) =>
      run(async () =>
        (await getClient(account)).sendJson("POST", `${GMAIL}/settings/filters`, {
          criteria: { from, to, subject, query },
          action: { addLabelIds: add_label_ids ?? [], removeLabelIds: remove_label_ids ?? [] },
        }),
      ),
  );

  server.registerTool(
    "gmail_delete_filter",
    {
      description: "Delete a Gmail filter. Requires confirm: true.",
      inputSchema: { filter_id: z.string(), confirm: z.boolean().optional(), account: ACCOUNT_PARAM },
      annotations: DESTRUCTIVE,
    },
    async ({ filter_id, confirm, account }) => {
      if (confirm !== true) return needsConfirm();
      return run(async () => {
        await (await getClient(account)).delete(`${GMAIL}/settings/filters/${filter_id}`);
        return { deleted: filter_id };
      });
    },
  );
}
