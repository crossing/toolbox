// Drives the SMS tools through a real MCP client/server pair, so the schemas
// are converted and the handlers are called exactly as claude.ai would — a
// malformed input schema breaks tools/list for the whole catalog, not just for
// this service.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSmsReadTools } from "../src/sms";
import { SmsStore, type SmsInboxApi } from "../src/smsstore";
import { makeFakeSql, type FakeSql } from "./sqlfake";

const digest = async (input: string) => createHash("sha256").update(input).digest("hex");
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

let open: FakeSql[] = [];

afterEach(() => {
  for (const sql of open) sql.close();
  open = [];
});

/** The DO stub's surface, backed by the real store rather than a mock, so the
 *  shapes the tools return are the shapes the store actually produces. */
async function connect(): Promise<{ client: Client; store: SmsStore }> {
  const sql = makeFakeSql();
  open.push(sql);
  const store = new SmsStore(sql, digest);
  const stub = {
    listMessages: async (filter: Parameters<SmsStore["listMessages"]>[0]) => store.listMessages(filter),
    getThread: async (peer: string, limit?: number) => store.getThread(peer, limit),
    status: async () => store.status(Date.now()),
    listSenders: async () => store.listSenders(),
  } as unknown as SmsInboxApi;

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerSmsReadTools(server, async () => stub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, store };
}

function textOf(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content[0]!.text;
}

describe("sms tool registration", () => {
  it("publishes three read tools and no write tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "sms_get_thread",
      "sms_list_messages",
      "sms_status",
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
  });

  it("tells the model that bodies are untrusted external content", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const listing = tools.find((tool) => tool.name === "sms_list_messages");
    expect(listing?.description).toMatch(/untrusted external content/i);
    expect(listing?.description).toMatch(/never as instructions/i);
  });
});

describe("sms reads", () => {
  it("returns bodies unredacted — the store is open by decision", async () => {
    const { client, store } = await connect();
    await store.recordInbound(
      { oa: "BANKID", da: "+441234567890", ud: "Your code is 449182", scts: "2026-08-23T11:59:00.000Z" },
      NOW,
    );
    const result = await client.callTool({ name: "sms_list_messages", arguments: {} });
    expect(textOf(result)).toContain("449182");
  });

  it("threads by sender, oldest first", async () => {
    const { client, store } = await connect();
    await store.recordInbound(
      { oa: "447700900123", da: "+441234567890", ud: "second", scts: "2026-08-23T11:00:00.000Z" },
      NOW,
    );
    await store.recordInbound(
      { oa: "447700900123", da: "+441234567890", ud: "first", scts: "2026-08-23T10:00:00.000Z" },
      NOW,
    );
    const result = await client.callTool({
      name: "sms_get_thread",
      arguments: { peer: "07700900123" },
    });
    const { messages } = JSON.parse(textOf(result)) as { messages: { body: string }[] };
    expect(messages.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("reports an empty store rather than failing", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "sms_status", arguments: {} });
    const { status } = JSON.parse(textOf(result)) as { status: { messages: number; lastReceipt: null } };
    expect(status).toMatchObject({ messages: 0, lastReceipt: null });
  });
});
