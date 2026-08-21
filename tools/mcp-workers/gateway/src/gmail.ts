// Gmail tool surface (ported from gws-mcp, plus the gateway's `account`
// parameter on every tool). Read tools need only gmail.readonly on the
// linked account; write tools are registered solely for write-scope grants
// and need an account linked with write scopes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GoogleApiError, type GoogleClient } from "./googleapi";
import { ACCOUNT_PARAM, DESTRUCTIVE, needsConfirm, READ_ONLY, run, WRITE } from "./toolutil";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const BODY_CHAR_CAP = 20000;
const ATTACHMENT_BYTE_CAP = 1_000_000;

// Resolves (optional account label) → an authenticated client; the resolver
// also enforces service enablement, so every tool call fails closed.
export type GetClient = (account?: string) => Promise<GoogleClient>;

// ---- pure helpers (unit-tested) ----

export function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64UrlText(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// RFC 2047 encoded-word for non-ASCII header values.
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
}

export function buildRfc822(opts: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
}): string {
  const lines = [`To: ${opts.to}`];
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  lines.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  return lines.join("\r\n") + "\r\n\r\n" + opts.body;
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

export function registerGmailWriteTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "gmail_create_draft",
    {
      description: "Create a Gmail draft (plain-text). Never sends — drafts are reviewed and sent by the human.",
      inputSchema: {
        to: z.string().describe("Comma-separated recipients"),
        cc: z.string().optional(),
        bcc: z.string().optional(),
        subject: z.string(),
        body: z.string(),
        account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ to, cc, bcc, subject, body, account }) =>
      run(async () => {
        const raw = toBase64Url(buildRfc822({ to, cc, bcc, subject, body }));
        return (await getClient(account)).sendJson("POST", `${GMAIL}/drafts`, { message: { raw } });
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
