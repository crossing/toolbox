// Read tool surface, mirroring the freeagent CLI's read commands and op-mcp's
// read allowlist. Responses are the raw FreeAgent JSON, same as the CLI's
// output contract.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FreeAgentApiError, type FreeAgentClient } from "./api";
import { UpstreamError } from "./upstream";

type GetClient = () => FreeAgentClient;

function asResult(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

function asError(err: unknown) {
  let text: string;
  if (err instanceof FreeAgentApiError && err.status === 401) {
    text = "FreeAgent rejected the access token (401). Reconnect this connector to re-authorize.";
  } else if (err instanceof FreeAgentApiError || err instanceof UpstreamError) {
    text = err.message;
  } else {
    text = "unexpected error calling FreeAgent";
  }
  return { content: [{ type: "text" as const, text }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return asResult(await fn());
  } catch (err) {
    return asError(err);
  }
}

const fromDate = z.string().optional().describe("Only items dated on or after this date (YYYY-MM-DD)");

export function registerReadTools(server: McpServer, getClient: GetClient): void {
  server.registerTool(
    "bank_accounts_list",
    { description: "List all bank accounts.", inputSchema: {} },
    async () => run(() => getClient().get("/bank_accounts")),
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
    },
    async ({ bank_account, view, from_date }) =>
      run(() =>
        getClient().get("/bank_transactions", {
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
    },
    async ({ url }) => run(() => getClient().getUrl(url)),
  );

  server.registerTool(
    "bills_list",
    { description: "List bills.", inputSchema: {} },
    async () => run(() => getClient().get("/bills")),
  );

  server.registerTool(
    "expenses_list",
    { description: "List out-of-pocket expenses.", inputSchema: { from_date: fromDate } },
    async ({ from_date }) => run(() => getClient().get("/expenses", { from_date, per_page: "100" })),
  );

  server.registerTool(
    "categories_list",
    { description: "List accounting categories (nominal codes).", inputSchema: {} },
    async () => run(() => getClient().get("/categories")),
  );

  server.registerTool(
    "contacts_list",
    {
      description: "List contacts (suppliers and clients).",
      inputSchema: {
        view: z.string().optional().describe("Filter: all, active, clients, suppliers (default active)"),
      },
    },
    async ({ view }) => run(() => getClient().get("/contacts", { view, per_page: "100" })),
  );

  server.registerTool(
    "balance_sheet",
    {
      description: "Show the balance sheet (assets, liabilities, owners' equity).",
      inputSchema: {
        as_at_date: z.string().optional().describe("Balance sheet as at this date (YYYY-MM-DD, default today)"),
      },
    },
    async ({ as_at_date }) => run(() => getClient().get("/accounting/balance_sheet", { as_at_date })),
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
    },
    async ({ from_date, to_date, accounting_period }) =>
      run(() => getClient().get("/accounting/profit_and_loss/summary", { from_date, to_date, accounting_period })),
  );

  server.registerTool(
    "trial_balance",
    {
      description: "Show the trial balance summary (per-category totals).",
      inputSchema: {
        from_date: z.string().optional().describe("Start date (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date (YYYY-MM-DD)"),
      },
    },
    async ({ from_date, to_date }) =>
      run(() => getClient().get("/accounting/trial_balance/summary", { from_date, to_date })),
  );
}
