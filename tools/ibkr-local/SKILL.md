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
