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
- **List transactions:** `freeagent transactions list --bank-account <account_uri>`

### Explanations
- **Create an explanation:**
  `freeagent explanations create --date <yyyy-mm-dd> --value <amount> --category <cat_uri> [--transaction <tx_uri> | --bank-account <account_uri>]`
- **Attach a file to an explanation:**
  `freeagent explanations attach --url <explanation_uri> --file <local_path>`

## Usage Guidelines
- Use `--human` flag for readable output when interacting with humans, but omit it for machine-readable JSON (default).
- All URIs should be absolute FreeAgent API URIs (e.g., `https://api.freeagent.com/v2/contacts/123`).
- When attaching files, ensure the file path is accessible to the environment where the CLI runs.
