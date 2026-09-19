// The gateway's WhatsApp service module.
//
// All the machinery lives in the bridge Durable Object, which belongs to a
// different Worker script (`whatsapp-bridge`) so a gateway deploy never evicts
// a live WhatsApp session. This module is a thin, typed client over the
// cross-script DO binding plus the MCP tool surface. The tool set was lifted
// tool-for-tool from the local whatsapp-mcp-server this replaced (retired
// 2026-09-16, lharries/whatsapp-mcp fork; see git history for the Go bridge).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";
import { WHATSAPP_SEND_BYTE_CAP } from "@toolbox/mcp-shared";
import { exportedFilename, fetchDriveAttachment, type DriveAttachment } from "./drive";
import type { Env } from "./env";
import type { GetClient } from "./gmail";
import {
  ACCOUNT_PARAM,
  asError,
  asMedia,
  asResult,
  BridgeError,
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  needsConfirm,
  runChecked,
} from "./toolutil";

// One bridge per gateway: a single WhatsApp account, one paired device.
export const BRIDGE_INSTANCE = "default";

export function bridgeFor(env: Env): WhatsAppBridgeApi {
  const ns = env.WHATSAPP_BRIDGE;
  // Cross-script stubs are untyped by wrangler; the class implements this
  // interface on the other side (shared/src/whatsapp-api.ts is the contract).
  // Do NOT wrap this stub in a Proxy: every property access on a Durable
  // Object stub is an RPC call in the making, so a get-trap turns `.apply`
  // into a remote method and makes the stub look thenable to `await`.
  return ns.get(ns.idFromName(BRIDGE_INSTANCE)) as unknown as WhatsAppBridgeApi;
}

// Errors thrown across the DO boundary arrive as plain Errors, which asError
// would flatten to "unexpected error calling the upstream service". Keep what
// the bridge actually said.
function asBridgeError(err: unknown): unknown {
  if (err instanceof Error) {
    return new BridgeError(`the WhatsApp bridge failed: ${err.message}`);
  }
  return err;
}

async function bridgeRun(fn: () => Promise<unknown>) {
  try {
    return asResult(await fn());
  } catch (err) {
    return asError(asBridgeError(err));
  }
}

// runChecked catches for itself, so a throw has to be translated *inside* the
// callback: wrapping the call in a try/catch here never fires, and the bridge's
// own words were being flattened to "unexpected error" for every checked tool.
async function bridgeRunChecked(fn: () => Promise<{ ok: boolean; detail?: string | null }>) {
  return runChecked(async () => {
    try {
      return await fn();
    } catch (err) {
      throw asBridgeError(err);
    }
  });
}

const JID_OR_PHONE = z
  .string()
  .describe("A chat JID (44700…@s.whatsapp.net, …@g.us) or a bare phone number in international format");

export function registerWhatsappReadTools(server: McpServer, bridge: () => Promise<WhatsAppBridgeApi>): void {
  server.registerTool(
    "whatsapp_search_contacts",
    {
      description:
        "Search WhatsApp contacts by name or phone number. Returns JIDs to use with the other WhatsApp tools.",
      inputSchema: {
        query: z.string().describe("Name or phone-number fragment to search for"),
        limit: z.number().int().min(1).max(200).optional().describe("Contacts to return (default 50)"),
        page: z.number().int().min(0).optional().describe("Zero-based page of results"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, page }) =>
      bridgeRun(async () => ({ contacts: await (await bridge()).searchContacts(query, limit, page) })),
  );

  server.registerTool(
    "whatsapp_list_chats",
    {
      description:
        "List WhatsApp chats, most recently active first. Each chat carries its lifecycle flags — archived, leftAt (a group this account has left) and deletedAt (deleted on WhatsApp) — and flagged chats stay listed: the bridge keeps the messages of a chat whatever happened to it on the phone.",
      inputSchema: {
        query: z.string().optional().describe("Filter by chat name or JID fragment"),
        limit: z.number().int().min(1).max(200).optional().describe("Chats to return (default 20)"),
        page: z.number().int().min(0).optional().describe("Zero-based page of results"),
        sort_by: z.enum(["last_active", "name"]).optional().describe("Sort order (default last_active)"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, page, sort_by }) =>
      bridgeRun(async () => ({
        chats: await (await bridge()).listChats({ query, limit, page, sortBy: sort_by }),
      })),
  );

  server.registerTool(
    "whatsapp_list_messages",
    {
      description:
        "List or search WhatsApp messages, newest first. Filter by chat, sender, text, or date range. A message deleted for everyone stays listed with revoked: true (its content kept, if the bridge saw it before the delete). undecryptable: true marks a placeholder for a message that arrived but could not be decrypted — a resend was requested and replaces it if it comes.",
      inputSchema: {
        chat_jid: z.string().optional().describe("Restrict to one chat (JID from whatsapp_list_chats)"),
        sender_phone_number: z
          .string()
          .optional()
          .describe("Restrict to one sender, by phone number or JID"),
        query: z.string().optional().describe("Substring to search for in message text"),
        after: z
          .string()
          .optional()
          .describe("Only messages after this ISO-8601 timestamp (any offset; converted to UTC)"),
        before: z
          .string()
          .optional()
          .describe("Only messages before this ISO-8601 timestamp (any offset; converted to UTC)"),
        limit: z.number().int().min(1).max(200).optional().describe("Messages to return (default 20)"),
        page: z.number().int().min(0).optional().describe("Zero-based page of results"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      bridgeRun(async () => ({
        messages: await (await bridge()).listMessages({
          chatJid: args.chat_jid,
          senderPhoneNumber: args.sender_phone_number,
          query: args.query,
          after: args.after,
          before: args.before,
          limit: args.limit,
          page: args.page,
        }),
      })),
  );

  server.registerTool(
    "whatsapp_get_chat",
    {
      description: "Metadata for one WhatsApp chat, including its archived / leftAt / deletedAt flags.",
      inputSchema: { chat_jid: z.string().describe("Chat JID") },
      annotations: READ_ONLY,
    },
    async ({ chat_jid }) => bridgeRun(async () => ({ chat: await (await bridge()).getChat(chat_jid) })),
  );

  server.registerTool(
    "whatsapp_get_direct_chat_by_contact",
    {
      description: "Find the one-to-one WhatsApp chat with a phone number.",
      inputSchema: {
        sender_phone_number: z
          .string()
          .describe("Phone number in international format, or the contact's JID"),
      },
      annotations: READ_ONLY,
    },
    async ({ sender_phone_number }) =>
      bridgeRun(async () => ({ chat: await (await bridge()).getDirectChatByContact(sender_phone_number) })),
  );

  server.registerTool(
    "whatsapp_get_contact_chats",
    {
      description: "List every WhatsApp chat a contact appears in, including groups.",
      inputSchema: {
        jid: JID_OR_PHONE,
        limit: z.number().int().min(1).max(200).optional().describe("Chats to return (default 20)"),
        page: z.number().int().min(0).optional().describe("Zero-based page of results"),
      },
      annotations: READ_ONLY,
    },
    async ({ jid, limit, page }) =>
      bridgeRun(async () => ({ chats: await (await bridge()).getContactChats(jid, limit, page) })),
  );

  server.registerTool(
    "whatsapp_get_last_interaction",
    {
      description: "The most recent WhatsApp message exchanged with a contact.",
      inputSchema: { jid: JID_OR_PHONE },
      annotations: READ_ONLY,
    },
    async ({ jid }) => bridgeRun(async () => (await bridge()).getLastInteraction(jid)),
  );

  server.registerTool(
    "whatsapp_get_message_context",
    {
      description: "The messages surrounding a given WhatsApp message, for reading a thread in order.",
      inputSchema: {
        message_id: z.string().describe("Message id from whatsapp_list_messages"),
        before: z.number().int().min(0).max(50).optional().describe("Messages before (default 5)"),
        after: z.number().int().min(0).max(50).optional().describe("Messages after (default 5)"),
      },
      annotations: READ_ONLY,
    },
    async ({ message_id, before, after }) =>
      bridgeRun(async () => (await bridge()).getMessageContext(message_id, before, after)),
  );

  server.registerTool(
    "whatsapp_download_media",
    {
      description:
        "Download and decrypt the media attached to a WhatsApp message. Images come back as images; other files come back described, with their bytes only when small (32 KB).",
      inputSchema: {
        message_id: z.string().describe("Message id from whatsapp_list_messages"),
        chat_jid: z.string().describe("The message's chat JID"),
      },
      annotations: READ_ONLY,
    },
    async ({ message_id, chat_jid }) => {
      try {
        return asMedia(await (await bridge()).downloadMedia(message_id, chat_jid));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "whatsapp_group_info",
    {
      description:
        "Live details of a WhatsApp group: subject, description, owner, and every participant with their phone number where WhatsApp supplies one (newer groups address members by an opaque …@lid), admin role, and the name the bridge already knows them by. admins lists the admins; inviteLink is included only when this account is an admin. Connects to WhatsApp, so it takes a few seconds. A participant's jid or phoneNumber can be passed to whatsapp_get_profile.",
      inputSchema: { group_jid: z.string().describe("Group JID (…@g.us) from whatsapp_list_chats") },
      annotations: READ_ONLY,
    },
    async ({ group_jid }) => bridgeRunChecked(async () => (await bridge()).groupInfo(group_jid)),
  );

  server.registerTool(
    "whatsapp_get_profile",
    {
      description:
        "Look up one person's WhatsApp profile, live: whether the number is on WhatsApp, their About text, profile picture URLs (links only — nothing is downloaded, and they expire), and their business profile when they have one — description, category, website, email, address and opening hours. Each field is fetched separately: one their privacy settings withhold comes back null, and one that failed is named in errors. name comes from the bridge's own store. Nothing is saved. Accepts a phone number in international format (447700900111, no leading 0), a user JID, or a group participant's …@lid. Connects to WhatsApp, so it takes a few seconds.",
      inputSchema: {
        jid_or_phone: z
          .string()
          .describe("Phone number in international format, a user JID (…@s.whatsapp.net), or a participant LID (…@lid)"),
      },
      annotations: READ_ONLY,
    },
    async ({ jid_or_phone }) => bridgeRunChecked(async () => (await bridge()).getProfile(jid_or_phone)),
  );

  server.registerTool(
    "whatsapp_bridge_status",
    {
      description:
        "Health of the WhatsApp bridge: whether a device is paired, when it last synced, and how much is stored.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      bridgeRun(async () => {
        const status = await (await bridge()).status();
        // A pairing code adds a device to the account, and so does a scanned
        // QR. Neither is ever worth putting in a model's context: the fact
        // that one is outstanding is all a tool needs to know. `status` does
        // not carry the QR string at all, so only the code needs flattening.
        return { ...status, pendingPairing: status.pendingPairing ? { pending: true } : null };
      }),
  );
}

// `getDriveClient` serves whatsapp_send_drive_file's server-side relay. It
// asserts Drive's own enablement when called, so a gateway with Drive switched
// off keeps every other WhatsApp write and only that one tool fails closed.
export function registerWhatsappWriteTools(
  server: McpServer,
  bridge: () => Promise<WhatsAppBridgeApi>,
  getDriveClient: GetClient,
): void {
  server.registerTool(
    "whatsapp_send_message",
    {
      description:
        "Send a WhatsApp text message. The recipient is a phone number in international format or a chat JID.",
      inputSchema: {
        recipient: JID_OR_PHONE,
        message: z.string().min(1).describe("The message text"),
      },
      annotations: WRITE,
    },
    async ({ recipient, message }) =>
      bridgeRunChecked(async () => (await bridge()).sendMessage(recipient, message)),
  );

  server.registerTool(
    "whatsapp_send_file",
    {
      description:
        "Send a file over WhatsApp with its bytes pasted inline as base64 — for small payloads only (a few KB you already hold), since the whole file has to be reproduced in the call. For anything that lives in Drive use whatsapp_send_drive_file instead, which relays it server-side. Image, video, audio or document, up to about 5 MB. Audio must already be Ogg/Opus — nothing here transcodes.",
      inputSchema: {
        recipient: JID_OR_PHONE,
        filename: z.string().describe("File name shown to the recipient"),
        base64: z.string().describe("File contents, base64-encoded (about 5 MB max)"),
        // The kind decides which WhatsApp message proto is built, and so how
        // the recipient's client renders it.
        media_type: z
          .enum(["image", "video", "audio", "document"])
          .optional()
          .describe("How WhatsApp should present it; inferred from the filename when omitted"),
        caption: z.string().optional().describe("Caption for image and video sends"),
        confirm: z.boolean().optional().describe("Must be true: sending a file is not reversible"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ recipient, filename, base64, media_type, caption, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).sendFile(recipient, filename, base64, media_type, caption));
    },
  );

  server.registerTool(
    "whatsapp_send_drive_file",
    {
      description:
        "Send a file that already lives in Google Drive over WhatsApp, without the bytes passing through this conversation — the gateway fetches it with the Drive account's credentials and hands it to the bridge. This is the preferred way to send a Drive file; whatsapp_send_file is for small inline payloads only. Google Docs/Slides/Drawings are exported as PDF and Sheets as xlsx on the way out. Same 5 MB cap as whatsapp_send_file; larger files are refused with their size. Find file_id with drive_search. Sending is not reversible, so confirm must be true.",
      inputSchema: {
        file_id: z.string().describe("Drive file id, from drive_search"),
        recipient: JID_OR_PHONE,
        filename: z.string().optional().describe("Name shown to the recipient; defaults to the Drive file's name"),
        caption: z.string().optional().describe("Caption for image and video sends"),
        media_type: z
          .enum(["image", "video", "audio", "document"])
          .optional()
          .describe("How WhatsApp should present it; inferred from the filename when omitted"),
        confirm: z.boolean().describe("Must be true: sending a file is not reversible"),
        drive_account: ACCOUNT_PARAM,
      },
      annotations: DESTRUCTIVE,
    },
    async ({ file_id, recipient, filename, caption, media_type, confirm, drive_account }) => {
      if (confirm !== true) return needsConfirm();
      let fetched: DriveAttachment;
      try {
        const drive = await getDriveClient(drive_account);
        fetched = await fetchDriveAttachment(drive, file_id, {
          accountHint: drive_account ? `the "${drive_account}" Drive account` : "the default Drive account",
          filename,
          // Refused on Drive's declared size, before any bytes are downloaded.
          byteCap: WHATSAPP_SEND_BYTE_CAP,
        });
      } catch (err) {
        return asError(err);
      }
      // The bridge picks the WhatsApp mime type from the extension, so an
      // exported Doc keeps its .pdf even when the caller chose the name.
      const name = exportedFilename(fetched.filename, fetched.mimeType);
      try {
        const sent = await (await bridge()).sendFile(recipient, name, fetched.base64, media_type, caption);
        const body = asResult({ ...sent, filename: name, size: fetched.bytes, mimeType: fetched.mimeType });
        return sent.ok ? body : { ...body, isError: true };
      } catch (err) {
        return asError(asBridgeError(err));
      }
    },
  );

  server.registerTool(
    "whatsapp_create_group",
    {
      description:
        "Create a WhatsApp group with this account as its admin. Returns groupJid (…@g.us), which works as a recipient for whatsapp_send_message straight away and shows up in whatsapp_list_chats. Creation is not all-or-nothing: each participant comes back with a status — added, invite_required (WhatsApp refused the direct add with 403 because of that person's privacy settings), failed (any other refusal, with WhatsApp's code) or unknown. When anyone could not be added, inviteLink carries the group's chat.whatsapp.com link so it can be sent to them by hand; this tool never sends it for you. Participants are phone numbers in international format (447700900111, no leading 0) or user JIDs, at most 32. Everyone added is notified and a group cannot be un-created, so confirm must be true.",
      inputSchema: {
        subject: z.string().min(1).max(100).describe("The group's name, up to 100 characters"),
        participants: z
          .array(
            z
              .string()
              .describe("A phone number in international format (447700900111) or a user JID (…@s.whatsapp.net)"),
          )
          .min(1)
          .max(32)
          .describe("Who to add, besides this account"),
        confirm: z.boolean().describe("Must be true: creating a group notifies everyone added and cannot be undone"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ subject, participants, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).createGroup(subject, participants));
    },
  );

  server.registerTool(
    "whatsapp_leave_group",
    {
      description:
        "Leave a WhatsApp group. The other members see that this account left, and rejoining needs an invite or an admin, so confirm must be true. The chat stays in whatsapp_list_chats with leftAt set and every stored message kept; to also remove the chat from WhatsApp use whatsapp_delete_chat afterwards.",
      inputSchema: {
        group_jid: z.string().describe("Group JID (…@g.us)"),
        confirm: z.boolean().describe("Must be true: leaving is visible to the group and cannot be undone from here"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ group_jid, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).leaveGroup(group_jid));
    },
  );

  server.registerTool(
    "whatsapp_archive_chat",
    {
      description:
        "Archive (archive: true) or unarchive (archive: false) a chat — a group or a one-to-one chat — on WhatsApp. It syncs to the phone like an archive made there. The chat stays in whatsapp_list_chats, flagged archived. Fails with an explanation, never silently, if this device holds no app-state sync key (see appStateProblem in whatsapp_bridge_status).",
      inputSchema: {
        chat_jid: z.string().describe("Chat JID from whatsapp_list_chats"),
        archive: z.boolean().describe("true to archive, false to unarchive"),
        confirm: z.boolean().describe("Must be true: this changes the chat list on the phone"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ chat_jid, archive, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).archiveChat(chat_jid, archive));
    },
  );

  server.registerTool(
    "whatsapp_delete_chat",
    {
      description:
        "Delete a chat on WhatsApp — it disappears from the phone and every linked device, and that cannot be undone there. THE BRIDGE'S OWN COPY IS KEPT: every stored message of the chat remains readable through whatsapp_list_messages, and the chat stays in whatsapp_list_chats with deletedAt set; messagesKept in the result says how many. A group is refused while this account is still a member, unless leave_first: true is passed, which leaves the group and then deletes the chat. Needs an app-state sync key, like whatsapp_archive_chat.",
      inputSchema: {
        chat_jid: z.string().describe("Chat JID from whatsapp_list_chats"),
        leave_first: z
          .boolean()
          .optional()
          .describe("For a group this account is still in: leave it, then delete the chat (default false: refuse)"),
        confirm: z.boolean().describe("Must be true: the chat is removed from WhatsApp on every device"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ chat_jid, leave_first, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).deleteChat(chat_jid, leave_first));
    },
  );

  server.registerTool(
    "whatsapp_revoke_message",
    {
      description:
        "Delete one of this account's own messages for everyone (\"withdraw\" it). Only messages this account sent, and only within about two days of sending — WhatsApp ignores a later request, so an older message is refused rather than reported as deleted. Recipients see that a message was deleted. The stored row is kept and flagged revoked. Take chat_jid and message_id from whatsapp_list_messages.",
      inputSchema: {
        chat_jid: z.string().describe("The message's chat JID"),
        message_id: z.string().describe("Message id from whatsapp_list_messages; must be one of this account's own"),
        confirm: z.boolean().describe("Must be true: recipients are shown that a message was deleted"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ chat_jid, message_id, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).revokeMessage(chat_jid, message_id));
    },
  );

  server.registerTool(
    "whatsapp_group_update_participants",
    {
      description:
        "Add, remove, promote (make admin) or demote members of a group this account administers. Like whatsapp_create_group it is not all-or-nothing: each participant comes back with a status — added / removed / promoted / demoted on success, invite_required when an add was refused with 403 by that person's privacy settings (inviteLink then carries the group's link to send them by hand), failed with WhatsApp's code otherwise, or unknown. Participants are phone numbers in international format (no leading 0), user JIDs, or …@lid JIDs from whatsapp_group_info; at most 32. This account itself is refused — use whatsapp_leave_group.",
      inputSchema: {
        group_jid: z.string().describe("Group JID (…@g.us)"),
        participants: z
          .array(z.string().describe("Phone number in international format, user JID, or participant LID"))
          .min(1)
          .max(32)
          .describe("Who to act on"),
        action: z.enum(["add", "remove", "promote", "demote"]).describe("What to do to them"),
        confirm: z.boolean().describe("Must be true: members are notified, and a removal cannot be taken back"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ group_jid, participants, action, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).groupUpdateParticipants(group_jid, participants, action));
    },
  );

  server.registerTool(
    "whatsapp_group_update_subject",
    {
      description:
        "Rename a WhatsApp group. Every member sees the change and who made it. Up to 100 characters.",
      inputSchema: {
        group_jid: z.string().describe("Group JID (…@g.us)"),
        subject: z.string().min(1).max(100).describe("The new name"),
        confirm: z.boolean().describe("Must be true: the rename is announced to the whole group"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ group_jid, subject, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).groupUpdateSubject(group_jid, subject));
    },
  );

  server.registerTool(
    "whatsapp_group_revoke_invite",
    {
      description:
        "Invalidate a group's invite link and return the new one. Every link handed out before stops working at once, including any this tool or whatsapp_create_group returned earlier. Needs this account to be an admin.",
      inputSchema: {
        group_jid: z.string().describe("Group JID (…@g.us)"),
        confirm: z.boolean().describe("Must be true: every existing invite link to the group stops working"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ group_jid, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return bridgeRunChecked(async () => (await bridge()).groupRevokeInvite(group_jid));
    },
  );

  server.registerTool(
    "whatsapp_sync_now",
    {
      description:
        "Force the WhatsApp bridge to connect and drain any pending messages, instead of waiting for its next scheduled sync.",
      inputSchema: {},
      annotations: WRITE,
    },
    async () => bridgeRunChecked(async () => (await bridge()).syncNow()),
  );
}

export async function bridgeStatusOrNull(env: Env) {
  try {
    return await bridgeFor(env).status();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export { asResult };
