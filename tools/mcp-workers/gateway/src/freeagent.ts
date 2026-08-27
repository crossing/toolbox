// FreeAgent read tool surface (ported from freeagent-mcp), mirroring the
// freeagent CLI's read commands and the retired op-mcp bridge's read allowlist. Responses are
// the raw FreeAgent JSON, same as the CLI's output contract.
//
// No `account` parameter here: the link-time company gate admits exactly one
// FreeAgent company, so tools always resolve the service's default (only)
// linked account. If ALLOWED_COMPANY ever becomes a list, add the parameter
// the way gmail/drive carry it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FreeAgentApiError, type FreeAgentClient } from "./freeagentapi";
import { DESTRUCTIVE, needsConfirm, READ_ONLY, run, WRITE } from "./toolutil";

export type GetFreeagentClient = () => Promise<FreeAgentClient>;

const fromDate = z.string().optional().describe("Only items dated on or after this date (YYYY-MM-DD)");

const EC_STATUS = z
  .string()
  .optional()
  .describe("EC/VAT status: 'UK/Non-EC' (default) or 'Reverse Charge' for services from overseas suppliers");

// Exactly one of category / paid_bill / transfer_account must describe the
// money; anything else is a caller mistake worth failing fast on, before a
// half-formed explanation reaches the books. Pure so it unit-tests.
export function explanationPayload(args: {
  transaction?: string;
  bank_account?: string;
  date: string;
  value: string;
  category?: string;
  description?: string;
  paid_bill?: string;
  transfer_account?: string;
  sales_tax_rate?: string;
  manual_sales_tax_amount?: string;
  ec_status?: string;
}): Record<string, unknown> {
  const targets = [args.category, args.paid_bill, args.transfer_account].filter(
    (v) => v !== undefined && v !== "",
  );
  if (targets.length !== 1) {
    throw new FreeAgentApiError(
      400,
      "exactly one of category, paid_bill, or transfer_account must be given",
    );
  }
  return {
    bank_transaction: args.transaction,
    bank_account: args.bank_account,
    dated_on: args.date,
    gross_value: args.value,
    category: args.category,
    description: args.description,
    paid_bill: args.paid_bill,
    transfer_bank_account: args.transfer_account,
    sales_tax_rate: args.sales_tax_rate,
    manual_sales_tax_amount: args.manual_sales_tax_amount,
    ec_status: args.ec_status,
  };
}

export function registerFreeagentReadTools(server: McpServer, getClient: GetFreeagentClient): void {
  server.registerTool(
    "freeagent_bank_accounts_list",
    { description: "List all bank accounts.", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/bank_accounts")),
  );

  server.registerTool(
    "freeagent_bank_transactions_list",
    {
      description:
        "List bank transactions for a bank account. Useful for finding transactions that need explanations.",
      inputSchema: {
        bank_account: z.string().describe("Bank account API URL (from freeagent_bank_accounts_list)"),
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
    "freeagent_bank_transaction_get",
    {
      description: "Show one bank transaction with its explanations.",
      inputSchema: { url: z.string().describe("Bank transaction API URL") },
      annotations: READ_ONLY,
    },
    async ({ url }) => run(async () => (await getClient()).getUrl(url)),
  );

  server.registerTool(
    "freeagent_bills_list",
    { description: "List bills.", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/bills")),
  );

  server.registerTool(
    "freeagent_expenses_list",
    {
      description: "List out-of-pocket expenses.",
      inputSchema: { from_date: fromDate },
      annotations: READ_ONLY,
    },
    async ({ from_date }) => run(async () => (await getClient()).get("/expenses", { from_date, per_page: "100" })),
  );

  server.registerTool(
    "freeagent_categories_list",
    { description: "List accounting categories (nominal codes).", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/categories")),
  );

  server.registerTool(
    "freeagent_contacts_list",
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
    "freeagent_balance_sheet",
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
    "freeagent_profit_and_loss",
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
    "freeagent_trial_balance",
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

  server.registerTool(
    "freeagent_users_list",
    {
      // Not in the original read set, but expense_create needs a user API
      // URL and there is no other way to discover one.
      description: "List the company's users (their API URLs are needed for freeagent_expense_create).",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => run(async () => (await getClient()).get("/users")),
  );
}

export function registerFreeagentWriteTools(server: McpServer, getClient: GetFreeagentClient): void {
  server.registerTool(
    "freeagent_bill_create",
    {
      description: "Create a bill (a supplier invoice to be paid) with a single line item.",
      inputSchema: {
        contact: z.string().describe("Contact API URL (from freeagent_contacts_list)"),
        reference: z.string().describe("Bill reference"),
        date: z.string().describe("Bill date (YYYY-MM-DD)"),
        due: z.string().describe("Due date (YYYY-MM-DD)"),
        category: z.string().describe("Category API URL (from freeagent_categories_list)"),
        value: z.string().describe("Total value"),
        description: z.string().optional().describe("Line item description"),
      },
      annotations: WRITE,
    },
    async ({ contact, reference, date, due, category, value, description }) =>
      run(async () =>
        (await getClient()).postJson("/bills", {
          bill: {
            contact,
            reference,
            dated_on: date,
            due_on: due,
            bill_items: [{ category, total_value: value, description }],
          },
        }),
      ),
  );

  server.registerTool(
    "freeagent_explanation_create",
    {
      description:
        "Explain a bank transaction. Exactly one of category (spending/income), paid_bill (a bill this payment settles), or transfer_account (the other own-account of a transfer) must be given.",
      inputSchema: {
        transaction: z.string().optional().describe("Bank transaction API URL (from freeagent_bank_transactions_list)"),
        bank_account: z.string().optional().describe("Bank account API URL (when creating a manual explanation)"),
        date: z.string().describe("Explanation date (YYYY-MM-DD)"),
        value: z.string().describe("Gross value (negative for money out)"),
        category: z.string().optional().describe("Category API URL"),
        description: z.string().optional(),
        paid_bill: z.string().optional().describe("Bill API URL this payment settles"),
        transfer_account: z.string().optional().describe("Other bank account API URL for a transfer"),
        sales_tax_rate: z.string().optional().describe("Sales tax (VAT) rate percentage, e.g. 20"),
        manual_sales_tax_amount: z
          .string()
          .optional()
          .describe("Explicit sales tax amount when a rate does not apply cleanly"),
        ec_status: EC_STATUS,
      },
      annotations: WRITE,
    },
    async (args) =>
      run(async () =>
        (await getClient()).postJson("/bank_transaction_explanations", {
          bank_transaction_explanation: explanationPayload(args),
        }),
      ),
  );

  server.registerTool(
    "freeagent_explanation_approve",
    {
      description:
        "Approve a marked-for-review explanation (one FreeAgent guessed from a bank feed), confirming its category.",
      inputSchema: { url: z.string().describe("Explanation API URL") },
      annotations: WRITE,
    },
    async ({ url }) =>
      run(async () =>
        (await getClient()).putUrl(url, {
          bank_transaction_explanation: { marked_for_review: false },
        }),
      ),
  );

  server.registerTool(
    "freeagent_explanation_delete",
    {
      description:
        "Delete an explanation, returning its bank transaction to the unexplained state. Requires confirm: true.",
      inputSchema: { url: z.string().describe("Explanation API URL"), confirm: z.boolean().optional() },
      annotations: DESTRUCTIVE,
    },
    async ({ url, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return run(async () => {
        await (await getClient()).deleteUrl(url);
        return { deleted: url };
      });
    },
  );

  server.registerTool(
    "freeagent_expense_create",
    {
      description:
        "Record an out-of-pocket expense (money a user paid personally on behalf of the company). Gross value must be negative for money paid out.",
      inputSchema: {
        user: z.string().describe("User API URL who paid (from freeagent_users_list)"),
        category: z.string().describe("Category API URL (from freeagent_categories_list)"),
        date: z.string().describe("Expense date (YYYY-MM-DD)"),
        value: z.string().describe("Gross value (negative for money paid out)"),
        description: z.string().optional(),
        sales_tax_rate: z.string().optional().describe("Sales tax (VAT) rate percentage, e.g. 20"),
        manual_sales_tax_amount: z
          .string()
          .optional()
          .describe("Explicit sales tax amount when a rate does not apply cleanly"),
        currency: z.string().optional().describe("Currency code when not the company's native currency, e.g. USD"),
        ec_status: EC_STATUS,
      },
      annotations: WRITE,
    },
    async ({ user, category, date, value, description, sales_tax_rate, manual_sales_tax_amount, currency, ec_status }) =>
      run(async () =>
        (await getClient()).postJson("/expenses", {
          expense: {
            user,
            category,
            dated_on: date,
            gross_value: value,
            description,
            sales_tax_rate,
            manual_sales_tax_amount,
            currency,
            ec_status,
          },
        }),
      ),
  );
}
