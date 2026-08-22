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
import { registerGmailReadTools, registerGmailWriteTools } from "./gmail";
import type { GoogleClient } from "./googleapi";
import { asResult, READ_ONLY } from "./toolutil";
import type { AccountInfo } from "./vault";

// The account namespace a Google link is stored under.
export const GOOGLE_ACCOUNT_SERVICE = "google";

// What tool handlers get: identity, grant tier, and live vault-backed
// resolvers. googleClient asserts the service is still enabled, then
// resolves (account label | default) → an authenticated client.
export interface GatewayToolContext {
  email: string;
  canWrite: boolean;
  googleClient(service: string, account?: string): Promise<GoogleClient>;
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

const gmailService: ServiceDef = {
  id: "gmail",
  title: "Gmail",
  description: "Search, read, drafts, labels, filters. No send tool exists; deletes are confirm-gated.",
  defaultEnabled: true,
  registerRead(server, ctx) {
    registerGmailReadTools(server, (account) => ctx.googleClient("gmail", account));
  },
  registerWrite(server, ctx) {
    registerGmailWriteTools(server, (account) => ctx.googleClient("gmail", account));
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
    registerDriveWriteTools(server, (account) => ctx.googleClient("drive", account));
  },
};

export const SERVICES: ServiceDef[] = [gmailService, driveService];

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
