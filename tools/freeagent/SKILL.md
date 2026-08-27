---
name: freeagent
description: Manage FreeAgent bills, bank transactions, and explanations. Prefer the MCP gateway's freeagent_* tools; this skill also documents the freeagent CLI, which is the fallback for attaching receipts.
---

# FreeAgent Skill

Reconciling bank transactions, managing bills, and pulling accounting reports out of
FreeAgent. There are two paths to the same company data: the **MCP gateway** (default)
and the **`freeagent` CLI** (fallback).

## When to Use
- When you need to list or create bills in FreeAgent.
- When you need to see unexplained bank transactions.
- When you need to reconcile a transaction by adding an explanation.
- When you need to attach a receipt or invoice (PDF/Image) to a bill or a transaction
  explanation — CLI only, see below.

## Prefer the MCP gateway

The hosted MCP gateway (connector "Gateway", `https://mcp.xing.works/mcp`) exposes
sixteen `freeagent_*` tools. Use them by default: they hold their own FreeAgent tokens,
so they cost no 1Password authorization, reads and writes both execute directly, and
every write is recorded in the gateway's audit log. `freeagent_explanation_delete` is
destructive and takes `confirm: true`.

| Task | Gateway tool | CLI equivalent |
|------|--------------|----------------|
| List bank accounts | `freeagent_bank_accounts_list` | — (URIs had to be known) |
| List transactions | `freeagent_bank_transactions_list` | `freeagent transactions list` |
| Show one transaction | `freeagent_bank_transaction_get` | `freeagent transactions get` |
| List bills | `freeagent_bills_list` | `freeagent bills list` |
| Create a bill | `freeagent_bill_create` | `freeagent bills create` |
| Create an explanation | `freeagent_explanation_create` | `freeagent explanations create` |
| Approve a guessed explanation | `freeagent_explanation_approve` | `freeagent explanations approve` |
| Delete an explanation | `freeagent_explanation_delete` | `freeagent explanations delete` |
| List / create expenses | `freeagent_expenses_list`, `freeagent_expense_create` | `freeagent expenses list\|create` |
| Balance sheet / P&L / trial balance | `freeagent_balance_sheet`, `freeagent_profit_and_loss`, `freeagent_trial_balance` | `freeagent balance-sheet\|profit-and-loss\|trial-balance` |
| Look up contacts, categories, users | `freeagent_contacts_list`, `freeagent_categories_list`, `freeagent_users_list` | — (not in the CLI) |
| **Attach a file** | **none — use the CLI** | `freeagent bills\|explanations attach` |

Gateway tools take snake_case arguments matching the CLI flags (`bank_account`,
`from_date`, `sales_tax_rate`, `ec_status`, `paid_bill`, `transfer_account`), and API
URLs rather than ids, exactly as the CLI does.

### The one gap: attachments

Neither the create tools nor any standalone tool can upload a file. Create the record
through the gateway, note the returned URL, then attach through the CLI:

```bash
op-freeagent bills attach --url <bill_uri> --file <local_path>
op-freeagent explanations attach --url <explanation_uri> --file <local_path>
```

Tracked as `work-ysf.1`.

## Log the gaps you hit

When a task drops to the CLI because the gateway has no tool for it, record it — that
list is what drives gateway parity work. Read `bd show work-ysf` first and only file a
new child if the gap is not already one of its children:

```bash
bd create "gateway: <what is missing>" --parent work-ysf -p 2 -l gateway,mcp \
  -d "<the task, and the CLI command used instead>"
```

Never stop a task to file one: run the CLI, finish the work, then log it.

## CLI reference

### Authentication
The tool requires the `FREEAGENT_ACCESS_TOKEN` environment variable, so run every
command through `op-freeagent`, never bare `freeagent`. Each invocation costs one
1Password desktop authorization — which is the reason the gateway comes first.

### Bills
- **List bills:** `freeagent bills list`
- **Create a bill:** 
  `freeagent bills create --contact <contact_uri> --reference <ref> --date <yyyy-mm-dd> --due <yyyy-mm-dd> --category <cat_uri> --value <amount>`
- **Attach a file to a bill:**
  `freeagent bills attach --url <bill_uri> --file <local_path>`

### Bank Transactions
- **List transactions:** `freeagent transactions list --bank-account <account_uri> [--view unexplained|marked_for_review|manual|imported] [--from <yyyy-mm-dd>]`
- **Show one transaction with its explanations:** `freeagent transactions get --url <tx_uri>`

### Explanations
- **Create an explanation:**
  `freeagent explanations create --date <yyyy-mm-dd> --value <amount> [--transaction <tx_uri> | --bank-account <account_uri>] [--sales-tax-rate <pct>] [--ec-status <status>] [--file <local_path>]`
  with exactly one of:
  - `--category <cat_uri>` — ordinary spending/income
  - `--paid-bill <bill_uri>` — payment settling a bill
  - `--transfer-account <account_uri>` — transfer between own accounts (the matching
    transaction on the other account is auto-explained)
- **Approve a guessed explanation:** `freeagent explanations approve --url <explanation_uri>`
  (clears `marked_for_review` on bank-feed guesses)
- **Delete an explanation:** `freeagent explanations delete --url <explanation_uri>`
- **Attach a file to an explanation:**
  `freeagent explanations attach --url <explanation_uri> --file <local_path>`

### Accounting Reports (read-only)
- **Balance sheet:** `freeagent balance-sheet [--as-at <yyyy-mm-dd>]`
  (assets, liabilities, owners' equity; default as at today)
- **Profit and loss:** `freeagent profit-and-loss [--from <yyyy-mm-dd> --to <yyyy-mm-dd> | --accounting-period <yyyy/yy>]`
  (default: current accounting period to date)
- **Trial balance:** `freeagent trial-balance [--from <yyyy-mm-dd>] [--to <yyyy-mm-dd>]`
  (per-category totals; use `display_nominal_code` when cross-referencing FreeAgent reports)

### Out-of-pocket Expenses
- **List expenses:** `freeagent expenses list [--from <yyyy-mm-dd>]`
- **Create an expense:**
  `freeagent expenses create --user <user_uri> --category <cat_uri> --date <yyyy-mm-dd> --value <amount> [--currency <code>] [--sales-tax-rate <pct>] [--ec-status <status>] [--file <local_path>]`
  - Value is negative for money the user paid out.
  - `--currency` takes the invoice currency (e.g. `USD`); FreeAgent converts to the
    company's native currency automatically.

## VAT on purchases from overseas suppliers

Applies to both paths. B2B services bought from suppliers outside the UK (SaaS
subscriptions, cloud, domains) fall under the HMRC reverse charge (VAT Notice 741A
s.5). Record them with `sales_tax_rate: "0"` and `ec_status: "Reverse Charge"`
(`--sales-tax-rate 0 --ec-status "Reverse Charge"` on the CLI) — FreeAgent then
accounts for the notional 20% in VAT-return boxes 1 and 4 and the value in boxes 6
and 7. Omitting the EC status books the purchase as a plain zero-rated UK cost and
under-reports the return.

Neither the gateway's `freeagent_bill_create` nor the CLI's `bills create` accepts a
sales tax rate or EC status, so a reverse-charge *bill* cannot be recorded correctly
by either path — record it as an explanation or expense, or edit the bill in the
FreeAgent web UI. Tracked as `work-ysf.9`.

## Usage Guidelines
- All URIs are absolute FreeAgent API URIs (e.g. `https://api.freeagent.com/v2/contacts/123`),
  on both paths.
- CLI only: use the `--human` flag for readable output when reporting to a human, and
  omit it for machine-readable JSON (the default).
- When attaching files, the path must be readable by the process running the CLI.
