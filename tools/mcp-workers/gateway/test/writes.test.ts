import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { explanationPayload } from "../src/freeagent";
import { FreeAgentApiError, staticClient } from "../src/freeagentapi";
import { auditedServer, summarizeArgs, type GatewayToolContext } from "../src/registry";

describe("explanationPayload", () => {
  const base = { date: "2026-08-21", value: "-12.50" };

  it("maps CLI-style args onto the API payload", () => {
    const payload = explanationPayload({
      ...base,
      transaction: "https://api.freeagent.com/v2/bank_transactions/1",
      category: "https://api.freeagent.com/v2/categories/285",
      description: "SaaS sub",
      sales_tax_rate: "0",
      ec_status: "Reverse Charge",
    });
    expect(payload).toMatchObject({
      bank_transaction: "https://api.freeagent.com/v2/bank_transactions/1",
      dated_on: "2026-08-21",
      gross_value: "-12.50",
      category: "https://api.freeagent.com/v2/categories/285",
      ec_status: "Reverse Charge",
    });
  });

  it("rejects zero money-describing fields", () => {
    expect(() => explanationPayload(base)).toThrow(FreeAgentApiError);
  });

  it("rejects more than one money-describing field", () => {
    expect(() =>
      explanationPayload({ ...base, category: "c", paid_bill: "b" }),
    ).toThrow(/exactly one/);
  });

  it("treats empty strings as absent", () => {
    expect(() => explanationPayload({ ...base, category: "", paid_bill: "b" })).not.toThrow();
  });
});

describe("FreeAgentClient writes", () => {
  function capture(body: unknown, status = 200) {
    const calls: { input: string; init?: RequestInit }[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fetcher };
  }

  it("postJson sends a JSON body with auth and user-agent", async () => {
    const { calls, fetcher } = capture({ ok: true });
    await staticClient("tok", fetcher).postJson("/bills", { bill: { reference: "r" } });
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ bill: { reference: "r" } });
  });

  it("putUrl and deleteUrl refuse non-API URLs before any request", async () => {
    const { calls, fetcher } = capture({});
    const client = staticClient("tok", fetcher);
    await expect(client.putUrl("https://evil.example/v2/x", {})).rejects.toThrow(FreeAgentApiError);
    await expect(client.deleteUrl("https://evil.example/v2/x")).rejects.toThrow(FreeAgentApiError);
    expect(calls).toHaveLength(0);
    await client.deleteUrl("https://api.freeagent.com/v2/bank_transaction_explanations/9");
    expect(calls[0]!.init?.method).toBe("DELETE");
  });
});

describe("auditedServer", () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean }>;

  function harness() {
    const registered = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        registered.set(name, handler);
      },
    } as unknown as McpServer;
    const entries: { tool: string; summary: string; status: string }[] = [];
    const ctx = {
      audit: async (tool: string, summary: string, status: "ok" | "error") => {
        entries.push({ tool, summary, status });
      },
    } as unknown as GatewayToolContext;
    return { server, registered, entries, ctx };
  }

  it("audits write calls with status from the result", async () => {
    const { server, registered, entries, ctx } = harness();
    const audited = auditedServer(server, ctx);
    audited.registerTool("w_ok", { annotations: { readOnlyHint: false } } as never, (async () => ({})) as never);
    audited.registerTool(
      "w_err",
      { annotations: { readOnlyHint: false } } as never,
      (async () => ({ isError: true })) as never,
    );
    await registered.get("w_ok")!({ a: 1 }, undefined);
    await registered.get("w_err")!({ b: 2 }, undefined);
    expect(entries).toEqual([
      { tool: "w_ok", summary: '{"a":1}', status: "ok" },
      { tool: "w_err", summary: '{"b":2}', status: "error" },
    ]);
  });

  it("leaves read-only tools unaudited", async () => {
    const { server, registered, entries, ctx } = harness();
    auditedServer(server, ctx).registerTool(
      "r",
      { annotations: { readOnlyHint: true } } as never,
      (async () => ({})) as never,
    );
    await registered.get("r")!({}, undefined);
    expect(entries).toHaveLength(0);
  });

  it("never fails the tool call when auditing throws", async () => {
    const { server, registered } = harness();
    const ctx = {
      audit: async () => {
        throw new Error("vault down");
      },
    } as unknown as GatewayToolContext;
    auditedServer(server, ctx).registerTool("w", { annotations: {} } as never, (async () => ({ fine: true })) as never);
    await expect(registered.get("w")!({}, undefined)).resolves.toMatchObject({ fine: true });
  });
});

describe("summarizeArgs", () => {
  it("caps long argument dumps", () => {
    const long = summarizeArgs({ body: "x".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith("…")).toBe(true);
  });
});
