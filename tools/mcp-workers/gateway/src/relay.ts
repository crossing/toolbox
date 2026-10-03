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
// Both tools are now thin wrappers over the file layer's transfer()
// (files/transfer.ts), kept with their original schemas so existing callers
// and routines keep working; file_transfer is the general form and these are
// deprecated in its favour.
//
// Read-then-file is still the other path: when the *content* has to be
// understood, fetch it, understand it, and write a note. These tools are for
// when it does not.
//
// The same reasoning runs outbound, in gmail.ts because the output is a draft
// rather than a file: `gmail_attach_drive_file` is the direct inverse of
// drive_save_gmail_attachment — a Drive file onto a draft that already exists —
// and `gmail_create_draft`'s `drive_attachments` does it at composition time.
// Likewise `whatsapp_send_drive_file` in whatsapp.ts is the inverse of
// drive_save_whatsapp_media: a Drive file out over the bridge.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { partialFileContext } from "./files/sources";
import { transfer, type TransferResult } from "./files/transfer";
import type { TransitCache } from "./files/transit";
import type { GoogleClient } from "./googleapi";
import { ACCOUNT_PARAM, run, WRITE } from "./toolutil";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";

const DEPRECATED = "Deprecated: prefer file_transfer. ";

export interface RelayClients {
  gmail(account?: string): Promise<GoogleClient>;
  drive(account?: string): Promise<GoogleClient>;
  whatsapp(): Promise<WhatsAppBridgeApi>;
  /** Where the `_Transit` id is cached, so parent_id "_Transit" works as it does in file_transfer. */
  vault: TransitCache;
}

/** The old result shape (Drive file JSON plus bytes/relayed), with the new ref and mode alongside. */
function relayResult(result: TransferResult): Record<string, unknown> {
  const file = (result.result ?? {}) as Record<string, unknown>;
  return { ...file, bytes: result.size, relayed: true, ref: result.ref, mode: result.mode };
}

export function registerRelayTools(server: McpServer, clients: RelayClients): void {
  const files = partialFileContext({ gmail: clients.gmail, drive: clients.drive, whatsapp: clients.whatsapp, vault: clients.vault });

  server.registerTool(
    "drive_save_gmail_attachment",
    {
      description:
        DEPRECATED +
        "Same as file_transfer from gmail:<message_id>/<attachment_id> to drive:folder/<parent_id>. " +
        "Copy a Gmail attachment straight into Drive without the bytes passing through this conversation — the gateway fetches it with the mail account's credentials and uploads it with the Drive account's. Prefer this over gmail_get_attachment + drive_create_file for anything you do not need to read: it costs no context and handles files up to 25 MB rather than 1 MB. Find message_id and attachment_id with gmail_get_message. For the opposite direction — a Drive file onto an outgoing message — use gmail_attach_drive_file, or gmail_create_draft's drive_attachments.",
      inputSchema: {
        message_id: z.string(),
        attachment_id: z.string(),
        name: z.string().describe("File name to save as — use 'YYYY-MM-DD <description>.<ext>'"),
        parent_id: z.string().optional().describe("Destination Drive folder id"),
        mime_type: z
          .string()
          .optional()
          .describe("Attachment's mime type from gmail_get_message; defaults to the type Gmail reports"),
        gmail_account: ACCOUNT_PARAM,
        drive_account: ACCOUNT_PARAM,
      },
      annotations: WRITE,
    },
    async ({ message_id, attachment_id, name, parent_id, mime_type, gmail_account, drive_account }) =>
      run(async () =>
        relayResult(
          await transfer(
            { kind: "gmail", messageId: message_id, attachmentId: attachment_id, ...(gmail_account !== undefined && { account: gmail_account }) },
            { kind: "drive-folder", parentId: parent_id ?? "root", ...(drive_account !== undefined && { account: drive_account }) },
            files,
            { name, ...(mime_type !== undefined && { mimeType: mime_type }) },
          ),
        ),
      ),
  );

  server.registerTool(
    "drive_save_whatsapp_media",
    {
      description:
        DEPRECATED +
        "Same as file_transfer from wa:<chat_jid>/<message_id> to drive:folder/<parent_id>. " +
        "Copy a WhatsApp attachment straight into Drive without the bytes passing through this conversation: the bridge decrypts it and streams it, and the gateway uploads it. Use whatsapp_list_messages to find the message id and chat jid.",
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
      run(async () =>
        relayResult(
          await transfer(
            { kind: "wa", chatJid: chat_jid, messageId: message_id },
            { kind: "drive-folder", parentId: parent_id ?? "root", ...(drive_account !== undefined && { account: drive_account }) },
            files,
            name !== undefined ? { name } : {},
          ),
        ),
      ),
  );
}
