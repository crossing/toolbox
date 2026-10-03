// FreeAgent read tool surface (ported from freeagent-mcp), mirroring the
// freeagent CLI's read commands and the retired op-mcp bridge's read allowlist. Responses are
// the FreeAgent JSON, sanitized by the client (no presigned attachment URLs;
// is_locked/locked_reason lead each record). List tools page, and add
// page/per_page/next_page beside the records.
//
// No `account` parameter here: the link-time company gate admits exactly one
// FreeAgent company, so tools always resolve the service's default (only)
// linked account. If ALLOWED_COMPANY ever becomes a list, add the parameter
// the way gmail/drive carry it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FREEAGENT_BASE_URL, FreeAgentApiError, isApiUrl, type FreeAgentClient } from "./freeagentapi";
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

// ---- paging -----------------------------------------------------------------

/**
 * newest / oldest: sorted on the record date. upstream: FreeAgent's own order,
 * one request per page.
 */
export type ListOrder = "newest" | "oldest" | "upstream";

/** Upstream pages (of 100) a date-sorted listing reads before giving up on sorting. */
export const SORT_MAX_UPSTREAM_PAGES = 10;
const UPSTREAM_PER_PAGE = 100;

export interface ListPageOptions {
  page: number;
  perPage: number;
  /**
   * newest / oldest: FreeAgent documents no order for bills, bank
   * transactions or expenses, and the live order is not by date (expenses come
   * back interleaved across years). So the gateway reads every matching record
   * in one pass of up to SORT_MAX_UPSTREAM_PAGES pages of 100, sorts on
   * `dateField` (ties on the record id), and slices the requested page. A
   * listing larger than that falls back to the upstream page with a note
   * asking for a narrower filter. upstream: FreeAgent's own order, one request.
   */
  order: ListOrder;
  /** The record date a sorted order sorts on; required for newest / oldest. */
  dateField?: string;
}

export interface ListPageResult {
  page: number;
  per_page: number;
  next_page: number | null;
  order: ListOrder;
  total?: number;
  note?: string;
  [key: string]: unknown;
}

function recordsOf(body: unknown, key: string): unknown[] {
  const list = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(list) ? list : [];
}

function urlOf(record: unknown): string {
  const url = (record as Record<string, unknown> | null)?.url;
  return typeof url === "string" ? url : "";
}

/** The trailing numeric id of a record's API URL, for a stable tie-break; 0 when absent. */
function idOf(record: unknown): number {
  const m = /\/(\d{1,20})$/.exec(urlOf(record));
  return m ? Number(m[1]) : 0;
}

/** One page of a FreeAgent list endpoint, as `{ <key>: [...], page, per_page, next_page, order }`. */
export async function listPage(
  client: FreeAgentClient,
  path: string,
  key: string,
  params: Record<string, string | undefined>,
  opts: ListPageOptions,
): Promise<ListPageResult> {
  const { page, perPage } = opts;
  const upstream = async (note?: string): Promise<ListPageResult> => {
    const got = await client.getPage(path, { ...params, page: String(page), per_page: String(perPage) });
    const records = recordsOf(got.body, key);
    // Trust the Link header when FreeAgent sent pagination headers at all;
    // otherwise a full page suggests there is another.
    const paged = got.nextPage !== null || got.lastPage !== null || got.total !== null;
    const next_page = paged ? got.nextPage : records.length >= perPage ? page + 1 : null;
    return {
      [key]: records,
      page,
      per_page: perPage,
      next_page,
      order: "upstream",
      ...(got.total !== null && { total: got.total }),
      ...(note !== undefined && { note }),
    };
  };
  if (opts.order === "upstream" || !opts.dateField) return upstream();

  // One pass over the whole filtered list, so the slice cannot drift between
  // a count and a later fetch. Records are de-duplicated by URL, and a change
  // in X-Total-Count between pages (a record added or removed mid-read) is
  // reported rather than silently shifting the page.
  const seen = new Set<string>();
  const all: unknown[] = [];
  let firstTotal: number | null = null;
  let changed = false;
  for (let up = 1; ; up++) {
    if (up > SORT_MAX_UPSTREAM_PAGES) {
      return upstream(
        `more than ${SORT_MAX_UPSTREAM_PAGES * UPSTREAM_PER_PAGE} records match, too many to sort; this page is FreeAgent's own order, which is not by date. Narrow with from_date/to_date or view for a ${opts.order}-first listing`,
      );
    }
    const got = await client.getPage(path, { ...params, page: String(up), per_page: String(UPSTREAM_PER_PAGE) });
    if (got.total !== null) {
      if (firstTotal === null) firstTotal = got.total;
      else if (got.total !== firstTotal) changed = true;
    }
    const records = recordsOf(got.body, key);
    for (const r of records) {
      const id = urlOf(r);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(r);
    }
    const paged = got.nextPage !== null || got.lastPage !== null || got.total !== null;
    // Link rel="next" is authoritative; X-Total-Count backs it up in case the
    // header is missing or unparsable, so a total above what was read never
    // ends the pass early.
    const more = paged
      ? got.nextPage !== null || (firstTotal !== null && all.length < firstTotal)
      : records.length >= UPSTREAM_PER_PAGE;
    if (!more || records.length === 0) break;
  }
  if (firstTotal !== null && firstTotal !== all.length) changed = true;

  const field = opts.dateField;
  const date = (r: unknown) => String((r as Record<string, unknown> | null)?.[field] ?? "");
  const dir = opts.order === "newest" ? -1 : 1;
  all.sort((a, b) => {
    const da = date(a);
    const db = date(b);
    if (da !== db) return da < db ? -dir : dir;
    return (idOf(a) - idOf(b)) * dir;
  });
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  return {
    [key]: slice,
    page,
    per_page: perPage,
    next_page: start + perPage < all.length ? page + 1 : null,
    order: opts.order,
    total: all.length,
    ...(changed && {
      note: "FreeAgent's list changed while it was being read (a record was added or removed); re-run for an exact page",
    }),
  };
}

/** A contact filter as FreeAgent wants it (an API URL), from a URL or a bare id. */
export function contactUrl(contact: string): string {
  if (/^\d{1,20}$/.test(contact)) return `${FREEAGENT_BASE_URL}/contacts/${contact}`;
  if (isApiUrl(contact) && /^\/v2\/contacts\/\d{1,20}$/.test(new URL(contact).pathname)) return contact;
  throw new FreeAgentApiError(400, `contact must be a FreeAgent contact id or its API URL (${FREEAGENT_BASE_URL}/contacts/<id>)`);
}

const PAGE = z.number().int().min(1).optional().describe("Page number, from 1 (default 1)");
const perPage = (dflt: number) =>
  z.number().int().min(1).max(100).optional().describe(`Records per page, 1-100 (default ${dflt})`);
const toDate = z.string().optional().describe("Only items dated on or before this date (YYYY-MM-DD)");
const UPDATED_SINCE = z
  .string()
  .optional()
  .describe("Only items changed since this ISO 8601 timestamp, e.g. 2026-10-01T00:00:00Z");
const ORDER = z
  .enum(["newest", "oldest", "upstream"])
  .optional()
  .describe(
    "newest (default): latest-dated first; oldest: earliest-dated first; upstream: FreeAgent's own order, which is not by date (one request, cheapest)",
  );
const PAGING_NOTE =
  " Returns one page: {<records>, page, per_page, next_page (null on the last page), order, total, note?}. A date-sorted listing reads up to 1000 matching records; past that it returns FreeAgent's own order with a note, so narrow with from_date/to_date. Records lead with is_locked/locked_reason where FreeAgent reports them; a record in a locked accounting period refuses edits and attachments.";

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
        "List bank transactions for a bank account, newest first. Useful for finding transactions that need explanations." +
        PAGING_NOTE,
      inputSchema: {
        bank_account: z.string().describe("Bank account API URL (from freeagent_bank_accounts_list)"),
        view: z
          .enum(["all", "unexplained", "explained", "manual", "imported", "marked_for_review"])
          .optional()
          .describe("Filter (default all)"),
        from_date: fromDate,
        to_date: toDate,
        updated_since: UPDATED_SINCE,
        page: PAGE,
        per_page: perPage(100),
        sort: ORDER,
      },
      annotations: READ_ONLY,
    },
    async ({ bank_account, view, from_date, to_date, updated_since, page, per_page, sort }) =>
      run(async () =>
        listPage(
          await getClient(),
          "/bank_transactions",
          "bank_transactions",
          { bank_account, view, from_date, to_date, updated_since },
          { page: page ?? 1, perPage: per_page ?? 100, order: sort ?? "newest", dateField: "dated_on" },
        ),
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
    {
      description: "List bills, newest first." + PAGING_NOTE,
      inputSchema: {
        view: z
          .enum([
            "all",
            "open",
            "overdue",
            "open_or_overdue",
            "open_or_overdue_payments",
            "open_or_overdue_refunds",
            "paid",
            "recurring",
            "hire_purchase",
            "cis",
          ])
          .optional()
          .describe("Filter (default all)"),
        from_date: fromDate,
        to_date: toDate,
        updated_since: UPDATED_SINCE,
        contact: z.string().optional().describe("Only bills from this contact (contact API URL or id)"),
        page: PAGE,
        per_page: perPage(25),
        sort: ORDER,
      },
      annotations: READ_ONLY,
    },
    async ({ view, from_date, to_date, updated_since, contact, page, per_page, sort }) =>
      run(async () =>
        listPage(
          await getClient(),
          "/bills",
          "bills",
          { view, from_date, to_date, updated_since, contact: contact ? contactUrl(contact) : undefined },
          { page: page ?? 1, perPage: per_page ?? 25, order: sort ?? "newest", dateField: "dated_on" },
        ),
      ),
  );

  server.registerTool(
    "freeagent_expenses_list",
    {
      description: "List out-of-pocket expenses, newest first." + PAGING_NOTE,
      inputSchema: {
        view: z.enum(["recent", "recurring"]).optional().describe("Filter (default: all expenses)"),
        from_date: fromDate,
        to_date: toDate,
        updated_since: UPDATED_SINCE,
        page: PAGE,
        per_page: perPage(100),
        sort: ORDER,
      },
      annotations: READ_ONLY,
    },
    async ({ view, from_date, to_date, updated_since, page, per_page, sort }) =>
      run(async () =>
        listPage(
          await getClient(),
          "/expenses",
          "expenses",
          { view, from_date, to_date, updated_since },
          { page: page ?? 1, perPage: per_page ?? 100, order: sort ?? "newest", dateField: "dated_on" },
        ),
      ),
  );

  server.registerTool(
    "freeagent_categories_list",
    { description: "List accounting categories (nominal codes).", inputSchema: {}, annotations: READ_ONLY },
    async () => run(async () => (await getClient()).get("/categories")),
  );

  server.registerTool(
    "freeagent_contacts_list",
    {
      description:
        "List contacts (suppliers and clients), by name unless sort says otherwise. Returns one page: {contacts, page, per_page, next_page}.",
      inputSchema: {
        view: z
          .enum([
            "all",
            "active",
            "clients",
            "suppliers",
            "active_projects",
            "completed_projects",
            "open_clients",
            "open_suppliers",
            "hidden",
          ])
          .optional()
          .describe("Filter (default active)"),
        sort: z
          .enum(["name", "-name", "created_at", "-created_at", "updated_at", "-updated_at"])
          .optional()
          .describe("FreeAgent's sort; a leading - is descending (default name)"),
        updated_since: UPDATED_SINCE,
        page: PAGE,
        per_page: perPage(100),
      },
      annotations: READ_ONLY,
    },
    async ({ view, sort, updated_since, page, per_page }) =>
      run(async () => {
        const result = await listPage(
          await getClient(),
          "/contacts",
          "contacts",
          { view, sort, updated_since },
          { page: page ?? 1, perPage: per_page ?? 100, order: "upstream" },
        );
        // Contacts follow FreeAgent's own sort argument; there is no date order to report.
        const { order: _order, ...rest } = result;
        return rest;
      }),
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

  server.registerTool(
    "freeagent_attachment_get",
    {
      description:
        "Show one attachment's metadata (id, url, file_name, content_type, file_size, description). Its bytes are never returned; copy them elsewhere with file_transfer from freeagent:attachment/<id>.",
      inputSchema: {
        attachment_id: z.string().describe("Attachment id, or its API URL (the attachment.url on a bill, expense or explanation)"),
      },
      annotations: READ_ONLY,
    },
    async ({ attachment_id }) => run(async () => ({ attachment: await (await getClient()).getAttachment(attachment_id) })),
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

  server.registerTool(
    "freeagent_attachment_delete",
    {
      description:
        "Delete an attachment from its bill, expense or explanation. FreeAgent refuses this for a record in a locked accounting period. Requires confirm: true.",
      inputSchema: {
        attachment_id: z.string().describe("Attachment id, or its API URL"),
        confirm: z.boolean().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ attachment_id, confirm }) => {
      if (confirm !== true) return needsConfirm();
      return run(async () => (await getClient()).deleteAttachment(attachment_id));
    },
  );
}
