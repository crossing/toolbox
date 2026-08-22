// The service registry: each entry contributes tools to the session catalog
// when the management page has it enabled. Catalog assembly happens once per
// MCP session (claude.ai re-reads the tool list per conversation); on top of
// that, every tool call re-resolves its client through the vault, so a
// service toggled off mid-conversation fails closed on the next call.
//
// Accounts: gmail and drive are separate catalog toggles but share one
// linked-account namespace ("google") — a single Google link covers both,
// because one upstream grant carries both services' scopes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDriveReadTools, registerDriveWriteTools } from "./drive";
import { registerFreeagentReadTools, registerFreeagentWriteTools } from "./freeagent";
import type { FreeAgentClient } from "./freeagentapi";
import { registerGmailReadTools, registerGmailWriteTools } from "./gmail";
import type { GoogleClient } from "./googleapi";
import { asResult, READ_ONLY } from "./toolutil";
import type { AccountInfo } from "./vault";
import { registerWhatsappReadTools, registerWhatsappWriteTools } from "./whatsapp";
import type { WhatsAppBridgeApi } from "@toolbox/mcp-shared";

// The account namespaces links are stored under.
export const GOOGLE_ACCOUNT_SERVICE = "google";
export const FREEAGENT_ACCOUNT_SERVICE = "freeagent";

// What tool handlers get: identity, grant tier, and live vault-backed
// resolvers. The client resolvers assert the service is still enabled, then
// resolve (account label | default) → an authenticated client.
export interface GatewayToolContext {
  email: string;
  canWrite: boolean;
  googleClient(service: string, account?: string): Promise<GoogleClient>;
  freeagentClient(): Promise<FreeAgentClient>;
  whatsappBridge(): Promise<WhatsAppBridgeApi>;
  listAccounts(): Promise<AccountInfo[]>;
  // Best-effort write audit into the vault; failures never fail a tool call.
  audit(tool: string, summary: string, status: "ok" | "error"): Promise<void>;
}

// Audit summaries keep the arg shape without dumping full content (drafts,
// file bodies) into the log.
export function summarizeArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? "{}";
  } catch {
    text = "{}";
  }
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

type AnyToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<{ isError?: boolean }>;
type AnyToolConfig = { annotations?: { readOnlyHint?: boolean } };

// Wraps registerTool so every non-read tool call lands in the audit log
// (including confirm-refusals and upstream failures, as status "error").
// Service modules occasionally register a read tool alongside their writes
// (gmail_list_filters); the readOnlyHint annotation keeps those out.
export function auditedServer(server: McpServer, ctx: GatewayToolContext): McpServer {
  const registerTool = (name: string, config: AnyToolConfig, handler: AnyToolHandler) => {
    const wrapped: AnyToolHandler =
      config.annotations?.readOnlyHint === true
        ? handler
        : async (args, extra) => {
            const result = await handler(args, extra);
            try {
              await ctx.audit(name, summarizeArgs(args), result?.isError ? "error" : "ok");
            } catch {
              // audit is best-effort
            }
            return result;
          };
    return (server.registerTool as unknown as (n: string, c: AnyToolConfig, h: AnyToolHandler) => unknown)(
      name,
      config,
      wrapped,
    );
  };
  return { registerTool } as unknown as McpServer;
}

export interface ServiceDef {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  registerRead(server: McpServer, ctx: GatewayToolContext): void;
  registerWrite?(server: McpServer, ctx: GatewayToolContext): void;
}

const gmailService: ServiceDef = {
  id: "gmail",
  title: "Gmail",
  description: "Search, read, drafts, labels, filters. No send tool exists; deletes are confirm-gated.",
  defaultEnabled: true,
  registerRead(server, ctx) {
    registerGmailReadTools(server, (account) => ctx.googleClient("gmail", account));
  },
  registerWrite(server, ctx) {
    registerGmailWriteTools(auditedServer(server, ctx), (account) => ctx.googleClient("gmail", account));
  },
};

const driveService: ServiceDef = {
  id: "drive",
  title: "Google Drive",
  description: "Search, metadata, content reads; create/update files. Deletion is trash-only and confirm-gated.",
  defaultEnabled: true,
  registerRead(server, ctx) {
    registerDriveReadTools(server, (account) => ctx.googleClient("drive", account));
  },
  registerWrite(server, ctx) {
    registerDriveWriteTools(auditedServer(server, ctx), (account) => ctx.googleClient("drive", account));
  },
};

const freeagentService: ServiceDef = {
  id: "freeagent",
  title: "FreeAgent",
  description:
    "Accounting reads (bank accounts/transactions, bills, expenses, contacts, reports) and writes (bill/explanation/expense create, approve; deletes confirm-gated).",
  defaultEnabled: true,
  registerRead(server, ctx) {
    registerFreeagentReadTools(server, () => ctx.freeagentClient());
  },
  registerWrite(server, ctx) {
    registerFreeagentWriteTools(auditedServer(server, ctx), () => ctx.freeagentClient());
  },
};

// Off until a device is paired on /manage/whatsapp: an unpaired bridge would
// otherwise add a dozen tools to the live catalog that can only answer "not
// paired yet".
const whatsappService: ServiceDef = {
  id: "whatsapp",
  title: "WhatsApp",
  description:
    "Chats, messages, contacts and media from the cloud bridge (a second linked device); file sends are confirm-gated.",
  defaultEnabled: false,
  registerRead(server, ctx) {
    registerWhatsappReadTools(server, () => ctx.whatsappBridge());
  },
  registerWrite(server, ctx) {
    registerWhatsappWriteTools(auditedServer(server, ctx), () => ctx.whatsappBridge());
  },
};

export const SERVICES: ServiceDef[] = [gmailService, driveService, freeagentService, whatsappService];

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
        return {
          content: [{ type: "text" as const, text: "could not read linked accounts from the vault" }],
          isError: true,
        };
      }
    },
  );
}
