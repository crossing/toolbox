// The gateway's WhatsApp service module.
//
// All the machinery lives in the bridge Durable Object, which belongs to a
// different Worker script (`whatsapp-bridge`) so a gateway deploy never evicts
// a live WhatsApp session. This module is a thin, typed client over the
// cross-script DO binding plus the MCP tool surface, mirroring the local
// tools/whatsapp-mcp-server tool-for-tool.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";
import type { Env } from "./env";
import {
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

async function bridgeRunChecked(fn: () => Promise<{ ok: boolean; detail?: string | null }>) {
  try {
    return await runChecked(fn);
  } catch (err) {
    return asError(asBridgeError(err));
  }
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
      description: "List WhatsApp chats, most recently active first.",
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
        "List or search WhatsApp messages, newest first. Filter by chat, sender, text, or date range.",
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
      description: "Metadata for one WhatsApp chat.",
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

export function registerWhatsappWriteTools(server: McpServer, bridge: () => Promise<WhatsAppBridgeApi>): void {
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
        "Send a file over WhatsApp: image, video, audio or document. Provide the bytes as base64, up to about 5 MB. Audio must already be Ogg/Opus — nothing here transcodes.",
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
