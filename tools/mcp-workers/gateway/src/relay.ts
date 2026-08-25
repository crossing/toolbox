// Moving bytes between accounts without routing them through a model.
//
// Gmail resolves to the work account here and Drive to the personal one, so
// Google's own "save to Drive" — which is same-account only — does not exist
// for this pair. The obvious workaround is `gmail_get_attachment` followed by
// `drive_create_file`, and it works, but every byte crosses the conversation
// twice as base64: a 120 KB PDF is 161 KB of base64 and costs roughly 80,000
// tokens to move. For an attachment nobody needs to *read*, that is the whole
// budget of a routine spent on plumbing.
//
// The gateway already holds both accounts' tokens, so it can just do the copy
// itself. These tools fetch with one identity and upload with the other inside
// the Worker; the model sees a file id and a size. The byte cap here is about
// Worker memory rather than context, which is why it is twenty-five times the
// one on `gmail_get_attachment`.
//
// Read-then-file is still the other path: when the *content* has to be
// understood, fetch it, understand it, and write a note. These tools are for
// when it does not.
//
// The same reasoning runs outbound: gmail_create_draft's `drive_attachments`
// is the inverse of drive_save_gmail_attachment, fetching with the Drive
// account and attaching with the mail account. It lives in gmail.ts because
// its output is a draft, exactly as these live here because theirs is a file.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DRIVE_UPLOAD, FILE_FIELDS, multipartBody } from "./drive";
import { GMAIL } from "./gmail";
import type { GoogleClient } from "./googleapi";
import { GoogleApiError } from "./googleapi";
import { ACCOUNT_PARAM, run, WRITE } from "./toolutil";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";

/** Worker memory, not context, is the constraint on this path. */
const RELAY_BYTE_CAP = 25 * 1024 * 1024;

export interface RelayClients {
  gmail(account?: string): Promise<GoogleClient>;
  drive(account?: string): Promise<GoogleClient>;
  whatsapp(): Promise<WhatsAppBridgeApi>;
}

async function uploadBase64(
  drive: GoogleClient,
  base64: string,
  name: string,
  parentId: string | undefined,
  mimeType: string,
): Promise<unknown> {
  // base64 is 4 characters per 3 bytes; close enough to refuse before we build
  // a multipart body we cannot hold.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > RELAY_BYTE_CAP) {
    throw new GoogleApiError(413, `attachment is about ${Math.round(approxBytes / 1024 / 1024)} MB; cap is 25 MB`);
  }
  const metadata: Record<string, unknown> = { name, mimeType };
  if (parentId) metadata.parents = [parentId];
  const { contentType, body } = multipartBody(metadata, { base64, mimeType });
  const file = (await drive.sendBody("POST", `${DRIVE_UPLOAD}/files`, contentType, body, {
    uploadType: "multipart",
    fields: FILE_FIELDS,
  })) as Record<string, unknown>;
  return { ...file, bytes: approxBytes, relayed: true };
}

export function registerRelayTools(server: McpServer, clients: RelayClients): void {
  server.registerTool(
    "drive_save_gmail_attachment",
    {
      description:
        "Copy a Gmail attachment straight into Drive without the bytes passing through this conversation — the gateway fetches it with the mail account's credentials and uploads it with the Drive account's. Prefer this over gmail_get_attachment + drive_create_file for anything you do not need to read: it costs no context and handles files up to 25 MB rather than 1 MB. Find message_id and attachment_id with gmail_get_message. For the opposite direction — a Drive file onto an outgoing message — use gmail_create_draft's drive_attachments.",
      inputSchema: {
        message_id: z.string(),
        attachment_id: z.string(),
        name: z.string().describe("File name to save as — use 'YYYY-MM-DD <description>.<ext>'"),
        parent_id: z.string().optional().describe("Destination Drive folder id"),
        mime_type: z
          .string()
          .optional()
          .describe("Attachment's mime type from gmail_get_message; defaults to application/octet-stream"),
        gmail_account: ACCOUNT_PARAM,
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ message_id, attachment_id, name, parent_id, mime_type, gmail_account, drive_account }) =>
      run(async () => {
        const mail = await clients.gmail(gmail_account);
        const att = (await mail.getJson(`${GMAIL}/messages/${message_id}/attachments/${attachment_id}`)) as {
          size?: number;
          data?: string;
        };
        if (!att.data) throw new GoogleApiError(404, "Gmail returned no attachment data");
        if ((att.size ?? 0) > RELAY_BYTE_CAP) {
          throw new GoogleApiError(413, `attachment is ${att.size} bytes; cap is ${RELAY_BYTE_CAP}`);
        }
        // Gmail speaks base64url; Drive wants standard base64.
        const base64 = att.data.replace(/-/g, "+").replace(/_/g, "/");
        return uploadBase64(
          await clients.drive(drive_account),
          base64,
          name,
          parent_id,
          mime_type ?? "application/octet-stream",
        );
      }),
  );

  server.registerTool(
    "drive_save_whatsapp_media",
    {
      description:
        "Copy a WhatsApp attachment straight into Drive without the bytes passing through this conversation. Same reasoning as drive_save_gmail_attachment: the bridge decrypts it and the gateway uploads it. Note the bridge's own inline caps still apply on this path — images up to 2 MB, other types only up to 32 KB — so a large document will be refused with its size; record it and fetch it from the phone instead. Use whatsapp_list_messages to find the message id and chat jid.",
      inputSchema: {
        message_id: z.string(),
        chat_jid: z.string(),
        name: z.string().optional().describe("File name to save as; defaults to the sender's filename"),
        parent_id: z.string().optional().describe("Destination Drive folder id"),
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ message_id, chat_jid, name, parent_id, drive_account }) =>
      run(async () => {
        const bridge = await clients.whatsapp();
        const media = await bridge.downloadMedia(message_id, chat_jid);
        if (!media.ok || !media.base64) {
          throw new GoogleApiError(400, media.detail ?? "the bridge returned no media");
        }
        return uploadBase64(
          await clients.drive(drive_account),
          media.base64,
          name ?? media.filename ?? `whatsapp-${message_id}`,
          parent_id,
          media.mimeType ?? "application/octet-stream",
        );
      }),
  );
}
