// Drives the WhatsApp tools through a real MCP client/server pair, so the
// schemas are converted and the handlers are called exactly as claude.ai would
// — a malformed input schema breaks tools/list for the whole catalog, and the
// service is registered for every session once it is enabled.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";
import { registerWhatsappReadTools, registerWhatsappWriteTools } from "../src/whatsapp";

const PNG_PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeBridge(overrides: Partial<WhatsAppBridgeApi> = {}): WhatsAppBridgeApi {
  const notImplemented = async () => {
    throw new Error("not used in this test");
  };
  return {
    status: async () => ({
      paired: true,
      me: { id: "447700900000:1@s.whatsapp.net", name: "Test" },
      pendingPairing: { phoneNumber: "447700900000", code: "ABCD-1234", expiresAt: Date.now() + 60_000 },
      connection: "idle",
      lastConnectedAt: null,
      lastDrainAt: null,
      lastError: null,
      nextAlarmAt: null,
      chatCount: 2,
      messageCount: 3,
      recentCycles: [],
      log: [],
    }),
    preflight: notImplemented as never,
    requestPairingCode: notImplemented as never,
    unpair: notImplemented as never,
    syncNow: async () => ({ ok: true, messages: 1, chats: 0, detail: null }),
    setAutoSync: notImplemented as never,
    setVerbose: notImplemented as never,
    setUseLatestVersion: notImplemented as never,
    searchContacts: async (query) => [{ jid: `${query}@s.whatsapp.net`, phoneNumber: query, name: "Ada" }],
    listMessages: async () => [],
    listChats: async () => [{ jid: "a@s.whatsapp.net", name: "Ada", lastMessageTime: null }],
    getChat: async () => null,
    getDirectChatByContact: async () => null,
    getContactChats: async () => [],
    getLastInteraction: async () => ({ message: null }),
    getMessageContext: async () => ({ message: null, before: [], after: [] }),
    downloadMedia: async () => ({
      ok: true,
      base64: PNG_PIXEL,
      mimeType: "image/png",
      filename: "pixel.png",
      size: 68,
    }),
    sendMessage: async () => ({ ok: true, messageId: "SENT1" }),
    sendFile: async () => ({ ok: false, detail: "not supported yet" }),
    issueImportCode: notImplemented as never,
    importRows: notImplemented as never,
    ...overrides,
  };
}

async function connect(bridge: WhatsAppBridgeApi, { write = true } = {}) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWhatsappReadTools(server, async () => bridge);
  if (write) registerWhatsappWriteTools(server, async () => bridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("whatsapp tool registration", () => {
  it("publishes the nine ported tools plus status, and marks reads read-only", async () => {
    const client = await connect(fakeBridge());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "whatsapp_bridge_status",
      "whatsapp_download_media",
      "whatsapp_get_chat",
      "whatsapp_get_contact_chats",
      "whatsapp_get_direct_chat_by_contact",
      "whatsapp_get_last_interaction",
      "whatsapp_get_message_context",
      "whatsapp_list_chats",
      "whatsapp_list_messages",
      "whatsapp_search_contacts",
      "whatsapp_send_file",
      "whatsapp_send_message",
      "whatsapp_sync_now",
    ]);
    const reads = tools.filter((tool) => tool.name.startsWith("whatsapp_") && !tool.name.includes("send"));
    for (const tool of reads) {
      if (tool.name === "whatsapp_sync_now") continue;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
    expect(tools.find((t) => t.name === "whatsapp_send_message")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "whatsapp_send_file")?.annotations?.destructiveHint).toBe(true);
  });

  it("registers no write tools for a read-only grant", async () => {
    const client = await connect(fakeBridge(), { write: false });
    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name.includes("send"))).toBe(false);
    expect(tools.some((tool) => tool.name === "whatsapp_sync_now")).toBe(false);
  });

  it("never puts the pairing code in a tool result", async () => {
    const client = await connect(fakeBridge());
    const result = await client.callTool({ name: "whatsapp_bridge_status", arguments: {} });
    const blocks = result.content as { type: string; text: string }[];
    expect(JSON.stringify(blocks)).not.toContain("ABCD-1234");
    const status = JSON.parse(blocks[0]!.text) as { pendingPairing: unknown; paired: boolean };
    expect(status.paired).toBe(true);
    expect(status.pendingPairing).toEqual({ pending: true });
  });

  it("returns an image block for image media", async () => {
    const client = await connect(fakeBridge());
    const result = await client.callTool({
      name: "whatsapp_download_media",
      arguments: { message_id: "M1", chat_jid: "a@s.whatsapp.net" },
    });
    const blocks = result.content as { type: string; mimeType?: string; data?: string }[];
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png", data: PNG_PIXEL });
  });

  it("surfaces a failed download as an error, not an image", async () => {
    const client = await connect(
      fakeBridge({ downloadMedia: async () => ({ ok: false, detail: "media expired" }) }),
    );
    const result = await client.callTool({
      name: "whatsapp_download_media",
      arguments: { message_id: "M1", chat_jid: "a@s.whatsapp.net" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("media expired");
  });

  it("refuses to send a file without confirm", async () => {
    let called = false;
    const client = await connect(
      fakeBridge({
        sendFile: async () => {
          called = true;
          return { ok: true };
        },
      }),
    );
    const result = await client.callTool({
      name: "whatsapp_send_file",
      arguments: { recipient: "447700900111", filename: "x.pdf", base64: "AAA" },
    });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("passes a text send through and reports the message id", async () => {
    const seen: string[] = [];
    const client = await connect(
      fakeBridge({
        sendMessage: async (recipient, message) => {
          seen.push(`${recipient}|${message}`);
          return { ok: true, messageId: "SENT1" };
        },
      }),
    );
    const result = await client.callTool({
      name: "whatsapp_send_message",
      arguments: { recipient: "447700900111", message: "hello" },
    });
    expect(seen).toEqual(["447700900111|hello"]);
    expect(JSON.stringify(result.content)).toContain("SENT1");
  });

  it("rejects an out-of-range limit before it reaches the bridge", async () => {
    let called = false;
    const client = await connect(fakeBridge({ listChats: async () => { called = true; return []; } }));
    // The SDK answers a schema violation with an error result rather than a
    // protocol error, but either way the handler must not run.
    const result = await client.callTool({ name: "whatsapp_list_chats", arguments: { limit: 5000 } });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });
});
