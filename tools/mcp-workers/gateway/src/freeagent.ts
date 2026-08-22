// FreeAgent read tool surface (ported from freeagent-mcp), mirroring the
// freeagent CLI's read commands and op-mcp's read allowlist. Responses are
// the raw FreeAgent JSON, same as the CLI's output contract.
//
// No `account` parameter here: the link-time company gate admits exactly one
// FreeAgent company, so tools always resolve the service's default (only)
// linked account. If ALLOWED_COMPANY ever becomes a list, add the parameter
// the way gmail/drive carry it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreeAgentClient } from "./freeagentapi";
import { READ_ONLY, run } from "./toolutil";

export type GetFreeagentClient = () => Promise<FreeAgentClient>;

const fromDate = z.string().optional().describe("Only items dated on or after this date (YYYY-MM-DD)");

export function registerFreeagentReadTools(server: McpServer, getClient: GetFreeagentClient): void {
  server.registerTool(
    "bank_accounts_list",
    { description: "List all bank accounts.", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/bank_accounts")),
  );

  server.registerTool(
    "bank_transactions_list",
    {
      description:
        "List bank transactions for a bank account. Useful for finding transactions that need explanations.",
      inputSchema: {
        bank_account: z.string().describe("Bank account API URL (from bank_accounts_list)"),
        view: z
          .string()
          .optional()
          .describe("Filter: unexplained, explained, manual, imported, marked_for_review"),
        from_date: fromDate,
      },
      annotations: READ_ONLY,
    },
    async ({ bank_account, view, from_date }) =>
      run(async () =>
        (await getClient()).get("/bank_transactions", {
          bank_account,
          view,
          from_date,
          per_page: "100",
        }),
      ),
  );

  server.registerTool(
    "bank_transaction_get",
    {
      description: "Show one bank transaction with its explanations.",
      inputSchema: { url: z.string().describe("Bank transaction API URL") },
      annotations: READ_ONLY,
    },
    async ({ url }) => run(async () => (await getClient()).getUrl(url)),
  );

  server.registerTool(
    "bills_list",
    { description: "List bills.", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/bills")),
  );

  server.registerTool(
    "expenses_list",
    {
      description: "List out-of-pocket expenses.",
      inputSchema: { from_date: fromDate },
      annotations: READ_ONLY,
    },
    async ({ from_date }) => run(async () => (await getClient()).get("/expenses", { from_date, per_page: "100" })),
  );

  server.registerTool(
    "categories_list",
    { description: "List accounting categories (nominal codes).", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/categories")),
  );

  server.registerTool(
    "contacts_list",
    {
      description: "List contacts (suppliers and clients).",
      inputSchema: {
        view: z.string().optional().describe("Filter: all, active, clients, suppliers (default active)"),
      },
      annotations: READ_ONLY,
    },
    async ({ view }) => run(async () => (await getClient()).get("/contacts", { view, per_page: "100" })),
  );

  server.registerTool(
    "balance_sheet",
    {
      description: "Show the balance sheet (assets, liabilities, owners' equity).",
      inputSchema: {
        as_at_date: z.string().optional().describe("Balance sheet as at this date (YYYY-MM-DD, default today)"),
      },
      annotations: READ_ONLY,
    },
    async ({ as_at_date }) => run(async () => (await getClient()).get("/accounting/balance_sheet", { as_at_date })),
  );

  server.registerTool(
    "profit_and_loss",
    {
      description: "Show the profit and loss summary.",
      inputSchema: {
        from_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
        accounting_period: z
          .string()
          .optional()
          .describe("Accounting year, e.g. 2025/26 (default: current period to date)"),
      },
      annotations: READ_ONLY,
    },
    async ({ from_date, to_date, accounting_period }) =>
      run(async () =>
        (await getClient()).get("/accounting/profit_and_loss/summary", { from_date, to_date, accounting_period }),
      ),
  );

  server.registerTool(
    "trial_balance",
    {
      description: "Show the trial balance summary (per-category totals).",
      inputSchema: {
        from_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      },
      annotations: READ_ONLY,
    },
    async ({ from_date, to_date }) =>
      run(async () => (await getClient()).get("/accounting/trial_balance/summary", { from_date, to_date })),
  );
}
