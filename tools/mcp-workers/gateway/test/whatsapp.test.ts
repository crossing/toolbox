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
      appStateProblem: null,
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
    listChats: async () => [
      { jid: "a@s.whatsapp.net", name: "Ada", lastMessageTime: null, archived: false, leftAt: null, deletedAt: null },
    ],
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
    createGroup: async () => ({ ok: false, detail: "not used in this test" }),
    leaveGroup: notImplemented as never,
    archiveChat: notImplemented as never,
    deleteChat: notImplemented as never,
    revokeMessage: notImplemented as never,
    groupInfo: notImplemented as never,
    getProfile: notImplemented as never,
    groupUpdateParticipants: notImplemented as never,
    groupUpdateSubject: notImplemented as never,
    groupRevokeInvite: notImplemented as never,
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

/** The tools that change something on WhatsApp beyond sending a message. */
const MUTATING = [
  "whatsapp_create_group",
  "whatsapp_leave_group",
  "whatsapp_archive_chat",
  "whatsapp_delete_chat",
  "whatsapp_revoke_message",
  "whatsapp_group_update_participants",
  "whatsapp_group_update_subject",
  "whatsapp_group_revoke_invite",
];

describe("whatsapp tool registration", () => {
  it("publishes the ported tools, status, and the lifecycle set, and marks reads read-only", async () => {
    const client = await connect(fakeBridge());
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "whatsapp_archive_chat",
      "whatsapp_bridge_status",
      "whatsapp_create_group",
      "whatsapp_delete_chat",
      "whatsapp_download_media",
      "whatsapp_get_chat",
      "whatsapp_get_contact_chats",
      "whatsapp_get_direct_chat_by_contact",
      "whatsapp_get_last_interaction",
      "whatsapp_get_message_context",
      "whatsapp_get_profile",
      "whatsapp_group_info",
      "whatsapp_group_revoke_invite",
      "whatsapp_group_update_participants",
      "whatsapp_group_update_subject",
      "whatsapp_leave_group",
      "whatsapp_list_chats",
      "whatsapp_list_messages",
      "whatsapp_revoke_message",
      "whatsapp_search_contacts",
      "whatsapp_send_drive_file",
      "whatsapp_send_file",
      "whatsapp_send_message",
      "whatsapp_sync_now",
    ]);
    // Everything that changes something on WhatsApp is destructive and cannot
    // be called without `confirm`; everything else is read-only.
    for (const tool of tools) {
      if (MUTATING.includes(tool.name)) {
        expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        expect((tool.inputSchema as { required?: string[] }).required, tool.name).toContain("confirm");
      } else if (!tool.name.includes("send") && tool.name !== "whatsapp_sync_now") {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      }
    }
    expect(tools.find((t) => t.name === "whatsapp_send_message")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "whatsapp_send_file")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "whatsapp_send_drive_file")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "whatsapp_create_group")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
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
    expect(tools.some((tool) => tool.name === "whatsapp_create_group")).toBe(false);
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

  it("keeps what the bridge said when a text send throws across the DO boundary", async () => {
    const client = await connect(
      fakeBridge({
        sendMessage: async () => {
          throw new Error("Durable Object reset");
        },
      }),
    );
    const result = await client.callTool({
      name: "whatsapp_send_message",
      arguments: { recipient: "447700900111", message: "hello" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Durable Object reset");
  });

  it("passes a group JID through to the bridge untouched", async () => {
    const seen: string[] = [];
    const client = await connect(
      fakeBridge({
        sendMessage: async (recipient) => {
          seen.push(recipient);
          return { ok: true, messageId: "SENT2" };
        },
      }),
    );
    await client.callTool({
      name: "whatsapp_send_message",
      arguments: { recipient: "120363000000000001@g.us", message: "hello group" },
    });
    expect(seen).toEqual(["120363000000000001@g.us"]);
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

// Creating a group adds people to something and notifies them, so it sits
// behind the same confirm gate as the file sends — and because WhatsApp answers
// per participant, a partial result is a success that has to be read, not an
// error.
describe("whatsapp_create_group", () => {
  const GROUP = "120363000000000001@g.us";

  function creatingBridge(result?: Awaited<ReturnType<WhatsAppBridgeApi["createGroup"]>>) {
    const calls: [string, string[]][] = [];
    const bridge = fakeBridge({
      createGroup: async (subject, participants) => {
        calls.push([subject, participants]);
        return (
          result ?? {
            ok: true,
            groupJid: GROUP,
            subject,
            participants: participants.map((requested) => ({
              requested,
              jid: `${requested}@s.whatsapp.net`,
              status: "added" as const,
              code: 200,
            })),
            inviteLink: null,
          }
        );
      },
    });
    return { calls, bridge };
  }

  it("makes subject, participants and confirm mandatory in the published schema", async () => {
    const client = await connect(fakeBridge());
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "whatsapp_create_group")!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["confirm", "participants", "subject"]);
    expect(schema.required!.sort()).toEqual(["confirm", "participants", "subject"]);
  });

  it("refuses without confirm: true, and never reaches the bridge", async () => {
    const { calls, bridge } = creatingBridge();
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111"], confirm: false },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("confirm");
    expect(calls).toEqual([]);
  });

  it("refuses when confirm is left out altogether", async () => {
    const { calls, bridge } = creatingBridge();
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111"] },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("rejects an empty participant list before it reaches the bridge", async () => {
    const { calls, bridge } = creatingBridge();
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: [], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("passes the request through and returns the group JID and per-participant results", async () => {
    const { calls, bridge } = creatingBridge();
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111", "447700900222"], confirm: true },
    });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([["Roof repair", ["447700900111", "447700900222"]]]);
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, groupJid: GROUP, subject: "Roof repair", inviteLink: null });
    expect(body.participants).toHaveLength(2);
  });

  it("reports a refused direct add as a success carrying the invite link, not as an error", async () => {
    const { bridge } = creatingBridge({
      ok: true,
      groupJid: GROUP,
      subject: "Roof repair",
      participants: [
        { requested: "447700900111", jid: "447700900111@s.whatsapp.net", status: "added", code: 200 },
        {
          requested: "447700900222",
          jid: "447700900222@s.whatsapp.net",
          status: "invite_required",
          code: 403,
          detail: "their privacy settings do not allow being added directly — send them the invite link",
        },
      ],
      inviteLink: "https://chat.whatsapp.com/AbCdEfGh",
    });
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111", "447700900222"], confirm: true },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as {
      inviteLink: string;
      participants: { status: string; code: number }[];
    };
    expect(body.inviteLink).toBe("https://chat.whatsapp.com/AbCdEfGh");
    expect(body.participants.map((p) => [p.status, p.code])).toEqual([
      ["added", 200],
      ["invite_required", 403],
    ]);
  });

  it("surfaces a bridge refusal as an error result", async () => {
    const { bridge } = creatingBridge({ ok: false, detail: "no device is paired" });
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111"], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no device is paired");
  });

  it("keeps what the bridge said when the DO call itself throws", async () => {
    const bridge = fakeBridge({
      createGroup: async () => {
        throw new Error("Durable Object reset");
      },
    });
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_create_group",
      arguments: { subject: "Roof repair", participants: ["447700900111"], confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Durable Object reset");
  });
});

// Leave, archive, delete, revoke and group admin. The gateway's whole job for
// these is the confirm gate and passing the bridge's words through intact, so
// each mutating tool is put through the same three questions.
describe("chat and group lifecycle tools", () => {
  const GROUP = "120363000000000001@g.us";
  const ADA = "447700900111@s.whatsapp.net";

  interface Case {
    tool: string;
    method: keyof WhatsAppBridgeApi;
    args: Record<string, unknown>;
    /** What the bridge method should have been called with. */
    passed: unknown[];
    result: { ok: true } & Record<string, unknown>;
  }

  const CASES: Case[] = [
    {
      tool: "whatsapp_leave_group",
      method: "leaveGroup",
      args: { group_jid: GROUP },
      passed: [GROUP],
      result: { ok: true, groupJid: GROUP, leftAt: "2026-09-19T12:00:00.000Z" },
    },
    {
      tool: "whatsapp_archive_chat",
      method: "archiveChat",
      args: { chat_jid: ADA, archive: true },
      passed: [ADA, true],
      result: { ok: true, chatJid: ADA, archived: true },
    },
    {
      tool: "whatsapp_delete_chat",
      method: "deleteChat",
      args: { chat_jid: GROUP, leave_first: true },
      passed: [GROUP, true],
      result: { ok: true, chatJid: GROUP, left: true, deletedAt: "2026-09-19T12:00:00.000Z", messagesKept: 14 },
    },
    {
      tool: "whatsapp_revoke_message",
      method: "revokeMessage",
      args: { chat_jid: ADA, message_id: "3EB0AAAA" },
      passed: [ADA, "3EB0AAAA"],
      result: { ok: true, chatJid: ADA, messageId: "3EB0AAAA", revokedAt: "2026-09-19T12:00:00.000Z" },
    },
    {
      tool: "whatsapp_group_update_participants",
      method: "groupUpdateParticipants",
      args: { group_jid: GROUP, participants: ["447700900111"], action: "remove" },
      passed: [GROUP, ["447700900111"], "remove"],
      result: {
        ok: true,
        groupJid: GROUP,
        action: "remove",
        participants: [{ requested: "447700900111", jid: ADA, status: "removed", code: 200 }],
        inviteLink: null,
      },
    },
    {
      tool: "whatsapp_group_update_subject",
      method: "groupUpdateSubject",
      args: { group_jid: GROUP, subject: "Roof repair — phase 2" },
      passed: [GROUP, "Roof repair — phase 2"],
      result: { ok: true, groupJid: GROUP, subject: "Roof repair — phase 2" },
    },
    {
      tool: "whatsapp_group_revoke_invite",
      method: "groupRevokeInvite",
      args: { group_jid: GROUP },
      passed: [GROUP],
      result: { ok: true, groupJid: GROUP, inviteLink: "https://chat.whatsapp.com/NewCode" },
    },
  ];

  function recording(method: keyof WhatsAppBridgeApi, result: unknown) {
    const calls: unknown[][] = [];
    const bridge = fakeBridge({
      [method]: async (...args: unknown[]) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    } as Partial<WhatsAppBridgeApi>);
    return { calls, bridge };
  }

  for (const c of CASES) {
    describe(c.tool, () => {
      it("refuses without confirm: true, and never reaches the bridge", async () => {
        const { calls, bridge } = recording(c.method, c.result);
        const client = await connect(bridge);
        for (const confirm of [false, undefined]) {
          const result = await client.callTool({
            name: c.tool,
            arguments: { ...c.args, ...(confirm === undefined ? {} : { confirm }) },
          });
          expect(result.isError, String(confirm)).toBe(true);
        }
        expect(calls).toEqual([]);
      });

      it("passes the request through and returns what the bridge said", async () => {
        const { calls, bridge } = recording(c.method, c.result);
        const client = await connect(bridge);
        const result = await client.callTool({ name: c.tool, arguments: { ...c.args, confirm: true } });
        expect(result.isError).toBeFalsy();
        expect(calls).toEqual([c.passed]);
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(c.result);
      });

      it("surfaces a refusal, and a throw across the DO boundary, in the bridge's own words", async () => {
        const refused = recording(c.method, { ok: false, detail: "the bridge is busy — try again in a moment" });
        let result = await (await connect(refused.bridge)).callTool({ name: c.tool, arguments: { ...c.args, confirm: true } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("the bridge is busy");

        const thrown = recording(c.method, new Error("Durable Object reset"));
        result = await (await connect(thrown.bridge)).callTool({ name: c.tool, arguments: { ...c.args, confirm: true } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("Durable Object reset");
      });

      it("is not registered for a read-only grant", async () => {
        const client = await connect(fakeBridge(), { write: false });
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).not.toContain(c.tool);
      });
    });
  }

  it("says in the delete tool's own description that the bridge keeps the messages", async () => {
    const client = await connect(fakeBridge());
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "whatsapp_delete_chat")!.description!;
    expect(description).toMatch(/BRIDGE'S OWN COPY IS KEPT/);
    expect(description).toMatch(/whatsapp_list_messages/);
  });

  it("reports an app-state refusal from archive as an error carrying the explanation", async () => {
    const { bridge } = recording("archiveChat", { ok: false, detail: "this device holds no app-state sync key: …" });
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_archive_chat",
      arguments: { chat_jid: ADA, archive: true, confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("no app-state sync key");
  });

  it("rejects an unknown participants action before it reaches the bridge", async () => {
    const { calls, bridge } = recording("groupUpdateParticipants", { ok: true });
    const client = await connect(bridge);
    const result = await client.callTool({
      name: "whatsapp_group_update_participants",
      arguments: { group_jid: GROUP, participants: ["447700900111"], action: "ban", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("shows lifecycle flags on listed chats and revoked / undecryptable on listed messages", async () => {
    const bridge = fakeBridge({
      listChats: async () => [
        { jid: GROUP, name: "Roof repair", lastMessageTime: null, archived: true, leftAt: "2026-09-19T12:00:00.000Z", deletedAt: null },
      ],
      listMessages: async () => [
        {
          id: "M1", chatJid: GROUP, chatName: "Roof repair", sender: ADA, senderName: "Ada", content: "sorry, wrong group",
          timestamp: "2026-09-19T11:00:00.000Z", isFromMe: false, mediaType: null, filename: null,
          revoked: true, revokedAt: "2026-09-19T11:01:00.000Z", undecryptable: false, decryptError: null,
        },
      ],
    });
    const client = await connect(bridge);
    const chats = await client.callTool({ name: "whatsapp_list_chats", arguments: {} });
    expect(JSON.parse((chats.content as { text: string }[])[0]!.text).chats[0]).toMatchObject({
      archived: true,
      leftAt: "2026-09-19T12:00:00.000Z",
    });
    const messages = await client.callTool({ name: "whatsapp_list_messages", arguments: { chat_jid: GROUP } });
    expect(JSON.parse((messages.content as { text: string }[])[0]!.text).messages[0]).toMatchObject({
      revoked: true,
      content: "sorry, wrong group",
    });
  });
});

describe("whatsapp_group_info and whatsapp_get_profile", () => {
  const GROUP = "120363000000000001@g.us";

  it("are read-only, need no confirm, and are there for a read-only grant", async () => {
    const client = await connect(fakeBridge(), { write: false });
    const { tools } = await client.listTools();
    for (const name of ["whatsapp_group_info", "whatsapp_get_profile"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations?.readOnlyHint, name).toBe(true);
      expect(Object.keys((tool.inputSchema as { properties: object }).properties), name).not.toContain("confirm");
    }
  });

  it("returns group info as the bridge gave it", async () => {
    const info = {
      ok: true,
      groupJid: GROUP,
      subject: "Roof repair",
      participants: [
        { jid: "199900000000001@lid", phoneNumber: "447700900111@s.whatsapp.net", lid: "199900000000001@lid", admin: null, isMe: false, name: "Ada" },
      ],
      admins: [],
      iAmAdmin: false,
      inviteLink: null,
    };
    const calls: string[] = [];
    const client = await connect(
      fakeBridge({
        groupInfo: async (jid) => {
          calls.push(jid);
          return info as never;
        },
      }),
    );
    const result = await client.callTool({ name: "whatsapp_group_info", arguments: { group_jid: GROUP } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([GROUP]);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(info);
  });

  it("returns a business profile, and a refusal as an error", async () => {
    const profile = {
      ok: true,
      requested: "447700900111",
      jid: "447700900111@s.whatsapp.net",
      exists: true,
      isBusiness: true,
      business: { description: "Lettings", category: "Estate agent", website: ["https://example.test"], email: null, address: null, hours: null },
    };
    const calls: string[] = [];
    const bridge = fakeBridge({
      getProfile: async (who) => {
        calls.push(who);
        return who.startsWith("0") ? { ok: false, detail: "national-format 0" } : (profile as never);
      },
    });
    const client = await connect(bridge);
    const ok = await client.callTool({ name: "whatsapp_get_profile", arguments: { jid_or_phone: "447700900111" } });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse((ok.content as { text: string }[])[0]!.text).business.website).toEqual(["https://example.test"]);
    const refused = await client.callTool({ name: "whatsapp_get_profile", arguments: { jid_or_phone: "07700900111" } });
    expect(refused.isError).toBe(true);
    expect(calls).toEqual(["447700900111", "07700900111"]);
  });
});
