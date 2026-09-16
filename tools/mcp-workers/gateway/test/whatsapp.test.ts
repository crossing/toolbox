// Drives the WhatsApp tools through a real MCP client/server pair, so the
// schemas are converted and the handlers are called exactly as claude.ai would
// — a malformed input schema breaks tools/list for the whole catalog, and the
// service is registered for every session once it is enabled.

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";
import { GoogleApiError } from "../src/googleapi";
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
      pendingQr: { issuedAt: Date.now(), expiresAt: Date.now() + 50_000 },
      deviceName: "Xing's Assistant",
      connection: "idle",
      autoSync: true,
      verbose: false,
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
    beginQrPairing: notImplemented as never,
    pairingQr: notImplemented as never,
    cancelPairing: notImplemented as never,
    setDeviceName: notImplemented as never,
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

interface DriveCall {
  url: string;
  query?: unknown;
}

interface FakeDriveOptions {
  meta?: { name?: string; mimeType?: string; size?: string };
  bytes?: Uint8Array;
  error?: GoogleApiError;
}

const PDF_BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]);
const PDF_B64 = Buffer.from(PDF_BYTES).toString("base64");

/** Just enough of GoogleClient for fetchDriveAttachment: metadata, then bytes. */
function fakeDrive(opts: FakeDriveOptions = {}) {
  const calls: DriveCall[] = [];
  const client = {
    async getJson(url: string, query?: unknown) {
      calls.push({ url, query });
      if (opts.error) throw opts.error;
      return opts.meta ?? { name: "contract.pdf", mimeType: "application/pdf", size: String(PDF_BYTES.byteLength) };
    },
    async getRaw(url: string, query?: unknown) {
      calls.push({ url, query });
      const bytes = opts.bytes ?? PDF_BYTES;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
  return { calls, client };
}

async function connect(
  bridge: WhatsAppBridgeApi,
  { write = true, drive = fakeDrive().client }: { write?: boolean; drive?: ReturnType<typeof fakeDrive>["client"] } = {},
) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerWhatsappReadTools(server, async () => bridge);
  if (write) registerWhatsappWriteTools(server, async () => bridge, (async () => drive) as never);
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
      "whatsapp_send_drive_file",
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
    expect(tools.find((t) => t.name === "whatsapp_send_drive_file")?.annotations?.destructiveHint).toBe(true);
  });

  it("makes confirm mandatory in the Drive relay's published schema", async () => {
    const client = await connect(fakeBridge());
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "whatsapp_send_drive_file")!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "caption",
      "confirm",
      "drive_account",
      "file_id",
      "filename",
      "media_type",
      "recipient",
    ]);
    expect(schema.required!.sort()).toEqual(["confirm", "file_id", "recipient"]);
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

// The outbound twin of drive_save_whatsapp_media: the gateway fetches the file
// from Drive and hands the bridge the same base64 whatsapp_send_file would
// have been given, so the bridge's send path — and its encryption fix — is
// shared rather than duplicated.
describe("whatsapp_send_drive_file", () => {
  type SendArgs = [string, string, string, string | undefined, string | undefined];

  function sendingBridge(result: { ok: boolean; messageId?: string; detail?: string } = { ok: true, messageId: "SENT9" }) {
    const sends: SendArgs[] = [];
    const bridge = fakeBridge({
      sendFile: async (recipient, filename, base64, mediaType, caption) => {
        sends.push([recipient, filename, base64, mediaType, caption]);
        return result;
      },
    });
    return { sends, bridge };
  }

  it("refuses without confirm, touching neither Drive nor the bridge", async () => {
    const { sends, bridge } = sendingBridge();
    const drive = fakeDrive();
    const client = await connect(bridge, { drive: drive.client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "FILE1", recipient: "447700900111", confirm: false },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("confirm");
    expect(drive.calls).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("relays a binary file through the bridge's send path and reports what went", async () => {
    const { sends, bridge } = sendingBridge();
    const drive = fakeDrive();
    const client = await connect(bridge, { drive: drive.client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "FILE1", recipient: "447700900111", caption: "signed copy", confirm: true },
    });
    expect(result.isError).toBeFalsy();
    // Metadata first, then alt=media — never an export for a plain PDF.
    expect(drive.calls.map((c) => c.url)).toEqual([
      "https://www.googleapis.com/drive/v3/files/FILE1",
      "https://www.googleapis.com/drive/v3/files/FILE1",
    ]);
    expect(drive.calls[1]!.query).toMatchObject({ alt: "media" });
    expect(sends).toEqual([["447700900111", "contract.pdf", PDF_B64, undefined, "signed copy"]]);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body).toEqual({
      ok: true,
      messageId: "SENT9",
      filename: "contract.pdf",
      size: PDF_BYTES.byteLength,
      mimeType: "application/pdf",
    });
  });

  it("honours a caller's filename and media_type", async () => {
    const { sends, bridge } = sendingBridge();
    const client = await connect(bridge, { drive: fakeDrive().client });
    await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: {
        file_id: "FILE1",
        recipient: "447700900111",
        filename: "2026-09-16 contract.pdf",
        media_type: "document",
        confirm: true,
      },
    });
    expect(sends).toEqual([["447700900111", "2026-09-16 contract.pdf", PDF_B64, "document", undefined]]);
  });

  it("exports a Google Doc to PDF and names it so the bridge picks the right mime type", async () => {
    const { sends, bridge } = sendingBridge();
    const drive = fakeDrive({ meta: { name: "Sale Pack", mimeType: "application/vnd.google-apps.document" } });
    const client = await connect(bridge, { drive: drive.client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "DOC1", recipient: "447700900111", filename: "Sale Pack", confirm: true },
    });
    expect(result.isError).toBeFalsy();
    expect(drive.calls[1]).toMatchObject({
      url: "https://www.googleapis.com/drive/v3/files/DOC1/export",
      query: { mimeType: "application/pdf" },
    });
    expect(sends[0]![1]).toBe("Sale Pack.pdf");
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, filename: "Sale Pack.pdf", mimeType: "application/pdf" });
  });

  it("refuses a file over the 5 MB send cap on its declared size, before downloading", async () => {
    const { sends, bridge } = sendingBridge();
    const drive = fakeDrive({ meta: { name: "video.mp4", mimeType: "video/mp4", size: String(6 * 1024 * 1024) } });
    const client = await connect(bridge, { drive: drive.client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "BIG1", recipient: "447700900111", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(`cap is ${5 * 1024 * 1024}`);
    // Only the metadata call happened.
    expect(drive.calls).toHaveLength(1);
    expect(sends).toEqual([]);
  });

  it("names the Drive account when the file id is not found there", async () => {
    const { sends, bridge } = sendingBridge();
    const drive = fakeDrive({ error: new GoogleApiError(404, "File not found") });
    const client = await connect(bridge, { drive: drive.client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "NOPE", recipient: "447700900111", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("the default Drive account");
    expect(sends).toEqual([]);
  });

  it("surfaces a bridge refusal as an error result that still says what was fetched", async () => {
    const { bridge } = sendingBridge({ ok: false, detail: "no device is paired" });
    const client = await connect(bridge, { drive: fakeDrive().client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "FILE1", recipient: "447700900111", confirm: true },
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, detail: "no device is paired", filename: "contract.pdf" });
  });

  it("keeps what the bridge said when the DO call itself throws", async () => {
    const bridge = fakeBridge({
      sendFile: async () => {
        throw new Error("Durable Object reset");
      },
    });
    const client = await connect(bridge, { drive: fakeDrive().client });
    const result = await client.callTool({
      name: "whatsapp_send_drive_file",
      arguments: { file_id: "FILE1", recipient: "447700900111", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Durable Object reset");
  });
});
