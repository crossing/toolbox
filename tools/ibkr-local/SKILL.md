---
name: ibkr-local
description: Query Interactive Brokers positions, balances and executions, and place governed orders through a local Gateway. Read operations are safe; order entry requires explicit owner authorization.
---

# ibkr-local

A guarded wrapper around a local Interactive Brokers Gateway. Read operations are
ordinary; **order entry is not**, and the guards exist because the failure mode is
irreversible and financial.

Invoke as `ibkr` or `ibkr-local` (the latter is an alias kept for existing callers).

## Read operations

Safe to run whenever you need current state. Always pass an explicit `--profile`:

```bash
ibkr balances   --profile main-live
ibkr positions  --profile main-live
ibkr executions --profile main-live --json
```

Profiles select which Gateway (and therefore which account set and API port) to talk
to. Never guess one — read it from the caller's configuration.

## Flex history (read-only, no Gateway needed)

`flex` fetches broker-reported history through the IBKR Flex Web Service instead of
the Gateway. It needs per-profile configuration in `profiles.json`: exactly one token
source — `flex.tokenRef` (an `op://` 1Password reference) or `flex.tokenFile` (an
absolute path to an owner-only file holding the token, e.g. a sops-nix secret) — and
one or more named queries. Either way the token itself is piped to the fetch helper
on stdin and never appears in argv, the environment, or output. When a profile has several queries, pass `--flex-query NAME`; with exactly
one it is selected automatically. The date window defaults to the last 365 days;
`--from/--to` request an exact inclusive range and long windows are chunked at 365
days automatically.

```bash
ibkr flex --profile main-live --flex-query nav-daily --json
ibkr flex --kind trades --profile main-live --flex-query tax-activity --from 2025-04-06 --to 2026-04-05
ibkr flex --kind dividends --profile main-live --flex-query tax-activity --days 90
```

The default `--kind raw` returns the raw statement XML as a JSON envelope of
`{from, to, xml}` chunks for callers that do their own parsing and validation; it
rejects `--account` because account-coverage checks belong to the caller. The parsed
kinds (`trades`, `transfers`, `dividends`) return row objects and accept `--account`
to filter to one account, failing closed if that account is absent from the
statement. Data may be delayed up to T-1; a failed fetch reports a sanitized error
with no URL, token, or upstream response text.

## Order entry

**Do not place an order unless the user has explicitly authorized that specific order
in the current conversation.** A general instruction to "manage" or "rebalance"
something is not authorization to trade.

The tool enforces a preview-then-confirm flow. Preserve it:

1. Preview the order and show the user the full result.
2. Wait for explicit confirmation of that exact order.
3. Only then confirm.

Never script around the preview step, never batch orders to avoid repeated
confirmation, and never infer a quantity the user did not state.

## Gateway not responding

The Gateway needs to be running and authenticated. If a command fails to connect, use
the `bootstrap-ibkr-gateway` skill to restart and re-authenticate rather than retrying
in a loop — repeated failed auth attempts can lock the account.

## Handling output

Account identifiers, positions, and values are private financial data.

- Do not copy account numbers, quantities, values, weights, cost basis, or P&L into
  anything that leaves the local environment — including commit messages, public repos,
  and issue trackers.
- Public identifiers (ticker, exchange, `con_id`, `security_id`) are fine.
- `--json` is the machine-readable form; prefer it when passing data to another tool.

## Notes

- Test fixtures in this repo use fake account numbers (`U00000001`…). Real ones must
  never appear here — this repository is public.
- The Gateway runtime and installer are pinned at build time; the tool never fetches a
  runtime from a mutable URL.
