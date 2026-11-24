// The caller record on write calls: what the transport carried, what the
// model declared, and the schema change that makes the declaration required.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callerFromContext, type CallerInfo } from "../src/caller";
import { auditedServer, type GatewayToolContext } from "../src/registry";
import { VaultStore } from "../src/vaultstore";
import { makeFakeSql } from "./sqlfake";

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/mcp", { method: "POST", headers });
}

describe("callerFromContext", () => {
  it("reads Claude Code's tool_use id, other vendor meta, headers and the OAuth client", () => {
    const info = callerFromContext(
      {
        mcpReq: {
          _meta: { "claudecode/toolUseId": "toolu_01", "claudecode/agentId": "a1", progressToken: 3 },
          envelope: { "io.modelcontextprotocol/clientInfo": { name: "claude-ai", version: "0.1" } },
        },
        http: { req: request({ "user-agent": "Claude-User" }), authInfo: { clientId: "cid" } },
      },
      "claude-code abc — title",
    );
    expect(info).toEqual({
      declared: "claude-code abc — title",
      toolUseId: "toolu_01",
      clientId: "cid",
      client: "claude-ai 0.1",
      userAgent: "Claude-User",
      meta: { "claudecode/agentId": "a1" },
    } satisfies CallerInfo);
  });

  it("takes a session id from a header, else from a meta key that names one", () => {
    expect(callerFromContext({ http: { req: request({ "x-claude-code-session-id": "s-hdr" }) } }).sessionId).toBe(
      "s-hdr",
    );
    expect(callerFromContext({ mcpReq: { _meta: { "anthropic/sessionId": "s-meta" } } }).sessionId).toBe("s-meta");
  });

  it("returns nothing for a bare context and clips long values", () => {
    expect(callerFromContext(undefined)).toEqual({});
    expect(callerFromContext({}, "x".repeat(500)).declared!.length).toBe(201);
  });
});

describe("auditedServer caller handling", () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean }>;

  function harness() {
    const registered = new Map<string, { config: { inputSchema?: z.ZodType }; handler: Handler }>();
    const server = {
      registerTool: (name: string, config: { inputSchema?: z.ZodType }, handler: Handler) => {
        registered.set(name, { config, handler });
      },
    } as unknown as McpServer;
    const callers: (CallerInfo | undefined)[] = [];
    const ctx = {
      audit: async (_tool: string, _summary: string, _status: string, caller?: CallerInfo) => {
        callers.push(caller);
      },
    } as unknown as GatewayToolContext;
    return { server, registered, callers, ctx };
  }

  it("requires `caller` on write tools only", () => {
    const { server, registered, ctx } = harness();
    const audited = auditedServer(server, ctx);
    audited.registerTool("w", { inputSchema: z.object({ a: z.string() }) } as never, (async () => ({})) as never);
    audited.registerTool(
      "r",
      { inputSchema: z.object({ a: z.string() }), annotations: { readOnlyHint: true } } as never,
      (async () => ({})) as never,
    );
    const write = registered.get("w")!.config.inputSchema!;
    expect(write.safeParse({ a: "x" }).success).toBe(false);
    expect(write.safeParse({ a: "x", caller: "claude-code s1" }).success).toBe(true);
    expect(registered.get("r")!.config.inputSchema!.safeParse({ a: "x" }).success).toBe(true);
  });

  it("hands the tool its arguments without `caller` and audits who called", async () => {
    const { server, registered, callers, ctx } = harness();
    let seen: Record<string, unknown> | undefined;
    auditedServer(server, ctx).registerTool(
      "w",
      { inputSchema: z.object({ a: z.string() }) } as never,
      (async (args: Record<string, unknown>) => {
        seen = args;
        return {};
      }) as never,
    );
    await registered.get("w")!.handler(
      { a: "x", caller: "claude.ai chat — quote" },
      { mcpReq: { _meta: { "claudecode/toolUseId": "toolu_9" } } },
    );
    expect(seen).toEqual({ a: "x" });
    expect(callers).toEqual([{ declared: "claude.ai chat — quote", toolUseId: "toolu_9" }]);
  });
});

describe("caller through the MCP handler", () => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    "user-agent": "Claude-User",
    host: "localhost",
  };

  async function call(handler: ReturnType<typeof createMcpHandler>, args: Record<string, unknown>) {
    const body = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "w", arguments: args, _meta: { "claudecode/toolUseId": "toolu_e2e" } },
    };
    const res = await handler.fetch(
      new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
    );
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text) as { result?: { isError?: boolean; content: { text: string }[] } };
  }

  it("refuses a write without `caller`, and records the tool_use id and user agent with one", async () => {
    const callers: (CallerInfo | undefined)[] = [];
    const ctx = {
      audit: async (_t: string, _s: string, _st: string, caller?: CallerInfo) => {
        callers.push(caller);
      },
    } as unknown as GatewayToolContext;
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "t", version: "1" });
        auditedServer(server, ctx).registerTool(
          "w",
          { inputSchema: z.object({ a: z.string() }) } as never,
          (async () => ({ content: [{ type: "text", text: "done" }] })) as never,
        );
        return server;
      },
      { route: "/mcp" },
    );

    const refused = await call(handler, { a: "x" });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content[0]!.text).toMatch(/caller/);
    expect(callers).toHaveLength(0);

    const ok = await call(handler, { a: "x", caller: "claude-code s1 — test" });
    expect(ok.result?.isError).toBeFalsy();
    expect(callers).toEqual([{ declared: "claude-code s1 — test", toolUseId: "toolu_e2e", userAgent: "Claude-User" }]);
  });
});

describe("VaultStore audit caller", () => {
  it("round-trips the caller and reads old rows without one", () => {
    const vault = new VaultStore(makeFakeSql());
    vault.appendAudit({ ts: 1, tool: "a", summary: "{}", status: "ok" });
    vault.appendAudit({ ts: 2, tool: "b", summary: "{}", status: "ok", caller: { declared: "d", toolUseId: "t" } });
    expect(vault.listAudit(10)).toEqual([
      { ts: 2, tool: "b", summary: "{}", status: "ok", caller: { declared: "d", toolUseId: "t" } },
      { ts: 1, tool: "a", summary: "{}", status: "ok" },
    ]);
  });

  it("adds the column to a vault created before callers were recorded", () => {
    const sql = makeFakeSql();
    sql.exec(
      "CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL)",
    );
    sql.exec("INSERT INTO audit (ts, tool, summary, status) VALUES (?, ?, ?, ?)", 1, "old", "{}", "ok");
    const vault = new VaultStore(sql);
    vault.appendAudit({ ts: 2, tool: "new", summary: "{}", status: "ok", caller: { declared: "d" } });
    expect(vault.listAudit(10).map((e) => [e.tool, e.caller])).toEqual([
      ["new", { declared: "d" }],
      ["old", undefined],
    ]);
    // A second start must not fail on the column now being there.
    expect(() => new VaultStore(sql)).not.toThrow();
  });
});
