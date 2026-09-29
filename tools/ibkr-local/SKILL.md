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

### Bonds and other identifier-based instruments

`bars`, `order-preview` and `order-prepare` take `--sec-type STK|BOND` (default `STK`) plus
`--conid ID` and/or `--isin ISIN`. A bond (for example a UK gilt) must be named by conId or
ISIN; IBKR does not resolve bonds by ticker. With either identifier the positional SYMBOL
is only a label. Pass the currency the bond is denominated in (`--currency GBP` for a gilt).

```bash
ibkr order-preview buy TN28 10 --profile main-paper --account U00000001 \
  --currency GBP --sec-type BOND --isin GB00BMBL1G81 --type LMT --limit 95
```

IBKR returns bond contracts with an empty `symbol`, `local_symbol` and `currency`, so the
preview adds `description` (for example `UKT 0 1/8 01/31/28`), `isin` and
`valid_exchanges`. Show the user `description`, `isin` and `con_id` before asking for
approval; the positional SYMBOL is only your label.

Units: the limit is a price per 100 nominal. The quantity unit is not documented by the
API; a live gilt what-if scaled its margin and accrued-interest effect as if one unit were
1,000 of nominal. Check the preview's margin and equity change against the intended size
before anything is prepared.

A prepared bond ticket records the requested selector and the previewed contract;
`order-submit` sends it by the previewed conId, so the order can only reach the
instrument that was previewed.

With `--isin`, the lookup is sent without an exchange (IBKR matches no ISIN once one is
named) and `--exchange` is then checked against the bond's valid exchanges and applied
for routing. `bars` for a bond returns no rows with the default `TRADES` (IBKR error
162); use `--what-to-show MIDPOINT`, `BID` or `ASK`.

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
