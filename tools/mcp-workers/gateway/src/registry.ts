// The service registry: each entry contributes tools to the session catalog
// when the management page has it enabled. Catalog assembly happens once per
// MCP session (claude.ai re-reads the tool list per conversation); on top of
// that, every tool call re-checks enablement through the vault so a service
// toggled off mid-conversation fails closed on the next call.
//
// G0 ships only the `echo` demo service to prove toggle → catalog behaviour;
// G1 folds in the gmail/drive modules, G2 freeagent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccountInfo } from "./vault";

export const READ_ONLY = { readOnlyHint: true } as const;

export class ServiceDisabledError extends Error {}

// What tool handlers get: identity, grant tier, and live vault lookups.
export interface GatewayToolContext {
  email: string;
  canWrite: boolean;
  assertServiceEnabled(service: string): Promise<void>;
  listAccounts(): Promise<AccountInfo[]>;
}

export interface ServiceDef {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  registerRead(server: McpServer, ctx: GatewayToolContext): void;
  registerWrite?(server: McpServer, ctx: GatewayToolContext): void;
}

function asResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function asError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function guarded(ctx: GatewayToolContext, service: string, fn: () => Promise<unknown>) {
  try {
    await ctx.assertServiceEnabled(service);
    return asResult(await fn());
  } catch (err) {
    if (err instanceof ServiceDisabledError) {
      return asError(`the ${service} service is disabled for this gateway; enable it on the management page`);
    }
    return asError(err instanceof Error ? err.message : "unexpected error");
  }
}

const echoService: ServiceDef = {
  id: "echo",
  title: "Echo (demo)",
  description: "Demo service proving catalog toggling; removed once real services fold in.",
  defaultEnabled: false,
  registerRead(server, ctx) {
    server.registerTool(
      "gateway_echo",
      {
        description: "Echo the input back. Demo tool for the gateway's service-toggle machinery.",
        inputSchema: { text: z.string() },
        annotations: READ_ONLY,
      },
      async ({ text }) => guarded(ctx, "echo", async () => ({ echo: text })),
    );
  },
};

export const SERVICES: ServiceDef[] = [echoService];

export function defaultServiceToggles(): Record<string, boolean> {
  return Object.fromEntries(SERVICES.map((svc) => [svc.id, svc.defaultEnabled]));
}

// Tools that exist in every session regardless of toggles.
export function registerGatewayTools(server: McpServer, ctx: GatewayToolContext): void {
  server.registerTool(
    "gateway_ping",
    {
      description: "Health check: confirms the gateway session is alive and shows the signed-in identity.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => asResult({ ok: true, email: ctx.email, writeToolsGranted: ctx.canWrite }),
  );

  server.registerTool(
    "list_accounts",
    {
      description:
        "List the accounts linked to this gateway (service, label, default flag). Multi-account tools take an `account` parameter matching a label here.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return asResult({ accounts: await ctx.listAccounts() });
      } catch {
        return asError("could not read linked accounts from the vault");
      }
    },
  );
}
