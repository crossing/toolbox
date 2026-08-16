---
name: freeagent
description: Manage FreeAgent bills, bank transactions, and explanations via CLI.
---

# FreeAgent CLI Skill

This skill allows an agent to interact with the FreeAgent accounting platform using the `freeagent` tool. It focuses on reconciling bank transactions and managing bills.

## When to Use
- When you need to list or create bills in FreeAgent.
- When you need to see unexplained bank transactions.
- When you need to reconcile a transaction by adding an explanation.
- When you need to attach a receipt or invoice (PDF/Image) to a bill or a transaction explanation.

## Commands

### Authentication
The tool requires `FREEAGENT_ACCESS_TOKEN` environment variable.

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

### Out-of-pocket Expenses
- **List expenses:** `freeagent expenses list [--from <yyyy-mm-dd>]`
- **Create an expense:**
  `freeagent expenses create --user <user_uri> --category <cat_uri> --date <yyyy-mm-dd> --value <amount> [--currency <code>] [--sales-tax-rate <pct>] [--ec-status <status>] [--file <local_path>]`
  - Value is negative for money the user paid out.
  - `--currency` takes the invoice currency (e.g. `USD`); FreeAgent converts to the
    company's native currency automatically.

### VAT on purchases from overseas suppliers
B2B services bought from suppliers outside the UK (SaaS subscriptions, cloud, domains)
fall under the HMRC reverse charge (VAT Notice 741A s.5). Record them with
`--sales-tax-rate 0 --ec-status "Reverse Charge"` — FreeAgent then accounts for the
notional 20% in VAT-return boxes 1 and 4 and the value in boxes 6 and 7. Omitting
`--ec-status` books the purchase as a plain zero-rated UK cost and under-reports the
return.

## Usage Guidelines
- Use `--human` flag for readable output when interacting with humans, but omit it for machine-readable JSON (default).
- All URIs should be absolute FreeAgent API URIs (e.g., `https://api.freeagent.com/v2/contacts/123`).
- When attaching files, ensure the file path is accessible to the environment where the CLI runs.
