#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
cli=$tool_dir/ibkr-local.sh
order_lib=$tool_dir/order-entry.sh
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

export XDG_RUNTIME_DIR="$test_root/runtime"
export XDG_STATE_HOME="$test_root/state"
export IBKR_LOCAL_CONFIG_DIR="$test_root/config"
export IBKR_LOCAL_PROFILES="$test_root/config/profiles.json"
export IBKR_LOCAL_XDG_CONFIG_HOME="$test_root/config"
export FAKE_LOG="$test_root/upstream.log"
export FAKE_MODE=success
export FAKE_PREAMBLE=1

mkdir -p "$XDG_RUNTIME_DIR" "$XDG_STATE_HOME" "$IBKR_LOCAL_CONFIG_DIR"

cat >"$IBKR_LOCAL_PROFILES" <<'JSON'
{
  "defaultProfile": "main-paper",
  "profiles": {
    "main-paper": {
      "ibkrProfile": "main-paper",
      "mode": "paper",
      "orderEntry": {
        "enable": true,
        "ticketTtlSeconds": 120,
        "allowedOrderTypes": ["LMT"],
        "allowOutsideRth": false
      }
    },
    "main-live": {
      "ibkrProfile": "main-live",
      "mode": "live",
      "orderEntry": {
        "enable": true,
        "ticketTtlSeconds": 120,
        "allowedOrderTypes": ["LMT"],
        "allowOutsideRth": false
      }
    },
    "disabled-live": {
      "ibkrProfile": "disabled-live",
      "mode": "live",
      "orderEntry": {
        "enable": false,
        "ticketTtlSeconds": 120,
        "allowedOrderTypes": ["LMT"],
        "allowOutsideRth": false
      }
    }
  }
}
JSON

fake_upstream="$test_root/fake-ibkr"
cat >"$fake_upstream" <<'SH'
#!/bin/sh
set -euo pipefail

printf '%q ' "$@" >>"$FAKE_LOG"
printf '\n' >>"$FAKE_LOG"

if [[ "${FAKE_PREAMBLE:-0}" == "1" ]]; then
  printf 'A new version 0.7.2 is available (current: 0.7.1). Run "ibkr update" to upgrade.\n'
fi

sec_type=STK
con_id=265598
preview_symbol=AAPL
preview_currency=USD
case " $* " in
  *' --sec-type BOND '*)
    sec_type=BOND
    con_id=${FAKE_BOND_CONID:-900000001}
    FAKE_ISIN=${FAKE_ISIN:-'"GB00BMBL1G81"'}
    ;;
  *' --sec-type CASH '*)
    sec_type=CASH
    con_id=${FAKE_FX_CONID:-12087797}
    preview_symbol=${FAKE_FX_SYMBOL:-GBP}
    ;;
esac

# The reference-rate read for a currency conversion: 1-minute MIDPOINT bars, newest last in
# time but deliberately not last in the list, shaped like upstream's `bars --json`.
if [[ "$1" == bars ]]; then
  now=$(date +%s)
  latest=$(date -u -d "@$((now - ${FAKE_FX_BAR_AGE:-60}))" +%Y-%m-%dT%H:%M:%S+00:00)
  earlier=$(date -u -d "@$((now - ${FAKE_FX_BAR_AGE:-60} - 60))" +%Y-%m-%dT%H:%M:%S+00:00)
  cat <<JSON
{
  "profile": "main-live",
  "symbol": "$preview_symbol",
  "local_symbol": "$preview_symbol.USD",
  "exchange": "IDEALPRO",
  "currency": "USD",
  "sec_type": "$sec_type",
  "con_id": $con_id,
  "pair": "$preview_symbol.USD",
  "min_tick": ${FAKE_FX_TICK:-5e-05},
  "what_to_show": "MIDPOINT",
  "count": 2,
  "rows": [
    {"date": "$latest", "open": 1.3, "high": 1.4, "low": 1.3, "close": ${FAKE_FX_REF:-1.34235}},
    {"date": "$earlier", "open": 1.2, "high": 1.2, "low": 1.2, "close": 1.2}
  ]
}
JSON
  exit 0
fi

case " $* " in
  *' --preview '*)
    cat <<JSON
{
  "profile": "main-live",
  "preview_only": true,
  "selected_account": "TEST123",
  "symbol": "$preview_symbol",
  "local_symbol": "AAPL",
  "exchange": "SMART",
  "primary_exchange": "NASDAQ",
  "currency": "$preview_currency",
  "sec_type": "$sec_type",
  "con_id": $con_id,
  "isin": ${FAKE_ISIN:-null},
  "status": "PreSubmitted",
  "commission": 1,
  "min_commission": 1,
  "max_commission": 1,
  "commission_currency": "USD",
  "init_margin_change": 100,
  "maint_margin_change": 100,
  "equity_with_loan_change": -100,
  "warning_text": null,
  "raw_error_codes": []
}
JSON
    ;;
  *' --submit '*|*' orders cancel '*)
    case "${FAKE_MODE:-success}" in
      success)
        printf '{"operation":"submit","status":"PreSubmitted","order_id":42,"selected_account":"TEST123"}\n'
        ;;
      reject)
        printf '{"error":"broker rejected test order"}\n'
        exit 1
        ;;
      timeout)
        exit 124
        ;;
      malformed)
        printf 'not-json\n'
        ;;
      *)
        exit 3
        ;;
    esac
    ;;
  *)
    printf '{"status":"Submitted","order_id":42,"selected_account":"TEST123"}\n'
    ;;
esac
SH
# quoted heredoc cannot expand: set a resolvable interpreter here.
sed -i "1s|.*|#!$(command -v bash)|" "$fake_upstream"
chmod +x "$fake_upstream"
export IBKR_UPSTREAM="$fake_upstream"

run_cli() {
  bash -c '
    order_lib=$1
    cli=$2
    shift 2
    source "$order_lib"
    source "$cli"
  ' _ "$order_lib" "$cli" "$@"
}

expect_fail() {
  if run_cli "$@" >"$test_root/unexpected.out" 2>"$test_root/expected.err"; then
    printf 'FAIL: command unexpectedly succeeded: %s\n' "$*" >&2
    return 1
  fi
}

prepare_ticket() {
  run_cli order-prepare buy AAPL 1 \
    --profile main-live --account TEST123 --type LMT --limit 100 \
    | jq -er '.ticketId'
}

rewrite_ticket() {
  local ticket_id=$1 filter=$2
  local ticket="$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$ticket_id.json"
  local body="$ticket.body" final="$ticket.final" checksum

  jq "$filter | del(.checksum)" "$ticket" >"$body"
  checksum=$(jq -cS 'del(.checksum)' "$body" | sha256sum | cut -d' ' -f1)
  jq --arg checksum "$checksum" '. + {checksum: $checksum}' "$body" >"$final"
  chmod 600 "$final"
  mv "$final" "$ticket"
  rm -f "$body"
}

run_prepare_tests() {
  : >"$FAKE_LOG"

  expect_fail order-prepare buy AAPL 1 --profile disabled-live --account TEST123 --type LMT --limit 100
  expect_fail order-prepare buy AAPL 1 --account TEST123 --type LMT --limit 100
  expect_fail order-prepare buy AAPL 1 --profile main-live --type LMT --limit 100
  expect_fail order-prepare buy AAPL 1 --profile main-live --account TEST123 --type MKT
  expect_fail order-prepare buy AAPL 1 --profile main-live --account TEST123 --type LMT --limit 100 --outside-rth

  ticket_json=$(run_cli order-prepare buy AAPL 1 --profile main-live --account TEST123 --type LMT --limit 100)
  ticket_id=$(jq -er '.ticketId' <<<"$ticket_json")
  ticket="$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$ticket_id.json"

  [[ -f "$ticket" ]]
  [[ "$(stat -c %a "$ticket")" == 600 ]]
  jq -e '
    .schemaVersion == 1
    and .account == "TEST123"
    and .order.orderType == "LMT"
    and .order.limitPrice == 100
    and .preview.previewOnly == true
    and (.checksum | length == 64)
  ' "$ticket" >/dev/null
  grep -q -- '--preview' "$FAKE_LOG"
  if grep -q -- '--submit' "$FAKE_LOG"; then
    echo 'FAIL: prepare invoked submit' >&2
    return 1
  fi

  printf 'PASS: guarded order preparation\n'
}

run_lifecycle_tests() {
  : >"$FAKE_LOG"
  export FAKE_MODE=success

  ticket_id=$(prepare_ticket)
  expect_fail order-submit "$ticket_id" --confirm wrong
  [[ "$(grep -c -- '--submit' "$FAKE_LOG" || true)" == 0 ]]

  expired_ticket=$(prepare_ticket)
  rewrite_ticket "$expired_ticket" '.expiresAt = 0'
  expect_fail order-submit "$expired_ticket" --confirm "$expired_ticket"
  [[ "$(grep -c -- '--submit' "$FAKE_LOG" || true)" == 0 ]]

  tampered_ticket=$(prepare_ticket)
  ticket_path="$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$tampered_ticket.json"
  jq '.account = "EDITED"' "$ticket_path" >"$ticket_path.edited"
  mv "$ticket_path.edited" "$ticket_path"
  expect_fail order-submit "$tampered_ticket" --confirm "$tampered_ticket"
  [[ "$(grep -c -- '--submit' "$FAKE_LOG" || true)" == 0 ]]

  run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 1 ]]
  expect_fail order-submit "$ticket_id" --confirm "$ticket_id"
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 1 ]]
  jq -e '.state == "submitted"' "$XDG_STATE_HOME/ibkr-local/orders/$ticket_id.json" >/dev/null

  timeout_ticket=$(prepare_ticket)
  export FAKE_MODE=timeout
  expect_fail order-submit "$timeout_ticket" --confirm "$timeout_ticket"
  jq -e '.state == "attempted-unknown"' \
    "$XDG_STATE_HOME/ibkr-local/orders/$timeout_ticket.json" >/dev/null
  export FAKE_MODE=success
  expect_fail order-submit "$timeout_ticket" --confirm "$timeout_ticket"

  concurrent_ticket=$(prepare_ticket)
  before=$(grep -c -- '--submit' "$FAKE_LOG")
  set +e
  run_cli order-submit "$concurrent_ticket" --confirm "$concurrent_ticket" \
    >"$test_root/concurrent-1.out" 2>"$test_root/concurrent-1.err" &
  pid1=$!
  run_cli order-submit "$concurrent_ticket" --confirm "$concurrent_ticket" \
    >"$test_root/concurrent-2.out" 2>"$test_root/concurrent-2.err" &
  pid2=$!
  wait "$pid1"
  status1=$?
  wait "$pid2"
  status2=$?
  set -e
  [[ "$status1" == 0 && "$status2" != 0 || "$status1" != 0 && "$status2" == 0 ]]
  after=$(grep -c -- '--submit' "$FAKE_LOG")
  [[ $((after - before)) == 1 ]]

  expect_fail order-cancel 42 --profile main-live --account TEST123 --confirm 41
  cancel_json=$(run_cli order-cancel 42 --profile main-live --account TEST123 --confirm 42)
  cancel_id=$(jq -er '.auditId' <<<"$cancel_json")
  grep -q 'orders cancel 42.*--account TEST123' "$FAKE_LOG"
  jq -e '.state == "submitted" and .cancellation.orderId == 42' \
    "$XDG_STATE_HOME/ibkr-local/orders/$cancel_id.json" >/dev/null

  export FAKE_MODE=timeout
  expect_fail order-cancel 43 --profile main-live --account TEST123 --confirm 43
  jq -e 'select(.state == "attempted-unknown" and .cancellation.orderId == 43)' \
    "$XDG_STATE_HOME"/ibkr-local/orders/cancel-*.json >/dev/null
  export FAKE_MODE=success

  if rg -n 'password|usernameRef|passwordRef|op://' "$XDG_STATE_HOME/ibkr-local/orders"; then
    echo 'FAIL: audit files contain protected configuration' >&2
    return 1
  fi

  printf 'PASS: guarded order submit and cancel lifecycle\n'
}

# Bonds are named by conId or ISIN. The selector reaches the preview, is recorded in the
# ticket, and submission is pinned to the conId the preview resolved -- never re-resolved
# from the ISIN. A plain STK ticker order forwards no selector at all.
run_bond_tests() {
  : >"$FAKE_LOG"
  export FAKE_MODE=success
  local isin=GB00BMBL1G81 ticket_json ticket_id ticket submit_line

  expect_fail order-prepare buy UKT 100 --profile main-live --account TEST123 --type LMT --limit 90 \
    --sec-type BOND
  grep -q 'BOND orders require --conid or --isin' "$test_root/expected.err"
  expect_fail order-prepare buy UKT 100 --profile main-live --account TEST123 --type LMT --limit 90 \
    --sec-type OPT --conid 1
  expect_fail order-prepare buy UKT 100 --profile main-live --account TEST123 --type LMT --limit 90 \
    --sec-type BOND --isin NOT-AN-ISIN
  expect_fail order-prepare buy UKT 100 --profile main-live --account TEST123 --type LMT --limit 90 \
    --sec-type BOND --conid 0
  [[ ! -s "$FAKE_LOG" ]] || { echo 'FAIL: invalid selector reached upstream' >&2; return 1; }

  # The broker resolved a different instrument than the conId asked for.
  expect_fail order-prepare buy UKT 100 --profile main-live --account TEST123 --type LMT --limit 90 \
    --sec-type BOND --conid 900000002
  grep -q 'did not confirm the requested instrument' "$test_root/expected.err"
  # ... or a different ISIN than the one requested.
  FAKE_ISIN='"GB00BMBL1F74"' expect_fail order-prepare buy UKT 100 --profile main-live \
    --account TEST123 --type LMT --limit 90 --sec-type BOND --isin GB00BMBL1G81
  grep -q 'did not confirm the requested instrument' "$test_root/expected.err"

  : >"$FAKE_LOG"
  ticket_json=$(run_cli order-prepare buy UKT 100 --profile main-live --account TEST123 \
    --currency GBP --sec-type bond --isin "${isin,,}" --type LMT --limit 90)
  ticket_id=$(jq -er '.ticketId' <<<"$ticket_json")
  ticket="$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$ticket_id.json"
  grep -q -- "--currency GBP --sec-type BOND --isin $isin --type LMT" "$FAKE_LOG"
  jq -e --arg isin "$isin" '
    .order.secType == "BOND" and .order.isin == $isin and .order.conId == null
    and .contract.secType == "BOND" and .contract.conId == 900000001
    and .contract.isin == $isin
  ' "$ticket" >/dev/null

  run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null
  submit_line=$(grep -- '--submit' "$FAKE_LOG")
  grep -q -- '--sec-type BOND --conid 900000001 --type LMT' <<<"$submit_line"
  if grep -q -- '--isin' <<<"$submit_line"; then
    echo 'FAIL: submit re-resolved the bond from its ISIN' >&2
    return 1
  fi

  # A ticket whose recorded contract no longer matches its security type is refused.
  ticket_id=$(run_cli order-prepare sell UKT 100 --profile main-live --account TEST123 \
    --currency GBP --sec-type BOND --conid 900000001 --type LMT --limit 90 | jq -er '.ticketId')
  rewrite_ticket "$ticket_id" '.contract.secType = "STK"'
  expect_fail order-submit "$ticket_id" --confirm "$ticket_id"
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 1 ]]

  # A plain stock order is forwarded exactly as before: no selector flags either way.
  : >"$FAKE_LOG"
  ticket_id=$(prepare_ticket)
  jq -e '.order.secType == "STK" and .order.conId == null and .order.isin == null' \
    "$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$ticket_id.json" >/dev/null
  run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null
  if grep -q -- '--sec-type\|--conid\|--isin' "$FAKE_LOG"; then
    echo 'FAIL: a stock order forwarded a selector' >&2
    return 1
  fi

  printf 'PASS: bond selector preparation and conId-pinned submission\n'
}

# Currency conversion: a slippage-capped marketable limit on IDEALPRO. The guard derives
# the limit from a fresh MIDPOINT reference rate and records the band; submission re-checks
# the band and is pinned to the conId whose rate was read.
fx_ticket() {
  "$@" | jq -er '.ticketId'
}

fx_ticket_path() {
  printf '%s\n' "$XDG_RUNTIME_DIR/ibkr-local/order-tickets/prepared/$1.json"
}

fx_prepare() {
  local side=$1
  shift
  run_cli order-prepare "$side" GBP.USD 1000 --profile main-live --account TEST123 \
    --sec-type CASH "$@"
}

expect_fx_limit() {
  local ticket_id=$1 limit=$2
  jq -e --argjson limit "$limit" '.order.limitPrice == $limit' "$(fx_ticket_path "$ticket_id")" >/dev/null \
    || { printf 'FAIL: expected limit %s, ticket has %s\n' "$limit" \
      "$(jq -c '.order.limitPrice' "$(fx_ticket_path "$ticket_id")")" >&2; return 1; }
}

run_fx_tests() {
  : >"$FAKE_LOG"
  export FAKE_MODE=success
  unset FAKE_FX_REF FAKE_FX_BAR_AGE FAKE_FX_CONID FAKE_FX_SYMBOL FAKE_FX_TICK
  local ticket_id ticket preview_line submit_line bps

  # Band maths: ref 1.34235. BUY 20 bp -> 1.3450347 floored to the 0.00005 tick; SELL
  # 20 bp -> 1.3396653 ceiled; 50 bp is the hard maximum.
  ticket_id=$(fx_ticket fx_prepare buy)
  ticket=$(fx_ticket_path "$ticket_id")
  expect_fx_limit "$ticket_id" 1.345
  jq -e '
    .order.secType == "CASH" and .order.symbol == "GBP.USD" and .order.conId == 12087797
    and .order.exchange == "IDEALPRO" and .order.currency == "USD" and .order.isin == null
    and .order.outsideRth == false and .order.quantity == 1000
    and .contract.secType == "CASH" and .contract.conId == 12087797
    and .order.fx.pair == "GBP.USD" and .order.fx.referenceRate == 1.34235
    and .order.fx.referenceSource == "MIDPOINT" and (.order.fx.referenceTime | type == "string")
    and .order.fx.maxSlippageBps == 20 and .order.fx.minTick == 0.00005
    and .order.fx.bandLow == 1.34235 and .order.fx.bandHigh == 1.345
    and .order.fx.limitSource == "derived"
  ' "$ticket" >/dev/null
  grep -q -- '^bars GBP.USD --profile main-live --exchange IDEALPRO --currency USD --sec-type CASH ' "$FAKE_LOG"
  grep -q -- '--what-to-show MIDPOINT --all-hours --json' "$FAKE_LOG"
  preview_line=$(grep -- '--preview' "$FAKE_LOG")
  grep -q -- '^buy GBP.USD 1000 .*--exchange IDEALPRO --currency USD --sec-type CASH --conid 12087797 --type LMT --limit 1.34500 --tif DAY --preview' \
    <<<"$preview_line"

  expect_fx_limit "$(fx_ticket fx_prepare sell)" 1.3397
  expect_fx_limit "$(fx_ticket fx_prepare buy --max-slippage-bps 50)" 1.34905
  expect_fx_limit "$(fx_ticket fx_prepare sell --max-slippage-bps 50)" 1.33565
  # A cap that lands exactly on a tick is kept, not rounded a tick inward by float error.
  FAKE_FX_REF=1.34 expect_fx_limit "$(FAKE_FX_REF=1.34 fx_ticket fx_prepare buy --max-slippage-bps 25)" 1.34335
  FAKE_FX_REF=1.34 expect_fx_limit "$(FAKE_FX_REF=1.34 fx_ticket fx_prepare sell --max-slippage-bps 25)" 1.33665
  # A 2.5x10^k tick keeps its own decimals: ref 1.3425, 1 bp caps BUY at 1.34263, which
  # floors to 1.3425 on the 0.0025 grid (not re-rounded to 1.343, above the cap).
  export FAKE_FX_REF=1.3425 FAKE_FX_TICK=0.0025
  : >"$FAKE_LOG"
  ticket_id=$(fx_ticket fx_prepare buy --max-slippage-bps 1)
  expect_fx_limit "$ticket_id" 1.3425
  grep -q -- '--type LMT --limit 1.3425 --tif DAY --preview' "$FAKE_LOG"
  expect_fx_limit "$(fx_ticket fx_prepare buy)" 1.345
  expect_fx_limit "$(fx_ticket fx_prepare sell)" 1.34
  expect_fx_limit "$(fx_ticket fx_prepare sell --max-slippage-bps 1)" 1.3425
  FAKE_FX_TICK=2.5e-04 expect_fx_limit "$(FAKE_FX_TICK=2.5e-04 fx_ticket fx_prepare buy --max-slippage-bps 2)" 1.34275
  # A tick with no short decimal form cannot be priced and is refused before any preview.
  : >"$FAKE_LOG"
  FAKE_FX_TICK=0.00003333333333 expect_fail order-prepare buy GBP.USD 1000 --profile main-live \
    --account TEST123 --sec-type CASH
  grep -q 'could not derive a 20 bp limit' "$test_root/expected.err"
  if grep -q -- '--preview' "$FAKE_LOG"; then
    echo 'FAIL: a CASH order with an unpriceable tick was previewed' >&2
    return 1
  fi
  unset FAKE_FX_REF FAKE_FX_TICK
  # The conId may be given; it is checked against the reference and the preview.
  fx_ticket fx_prepare buy --conid 12087797 >/dev/null
  # A quantity of 1000.50 GBP is a multiple of 0.01.
  run_cli order-prepare buy GBP.USD 1000.50 --profile main-live --account TEST123 --sec-type CASH >/dev/null

  # Refusals that never reach upstream.
  : >"$FAKE_LOG"
  for bps in 51 0 -5 abc 1.5 1000000000000000000000; do
    expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 \
      --sec-type CASH --max-slippage-bps "$bps"
    grep -q 'must be an integer from 1 to 50' "$test_root/expected.err"
  done
  expect_fail order-prepare buy GBP.USD 1000.005 --profile main-live --account TEST123 --sec-type CASH
  grep -q 'multiple of 0.01' "$test_root/expected.err"
  expect_fail order-prepare buy GBP.USD 1e3 --profile main-live --account TEST123 --sec-type CASH
  expect_fail order-prepare buy USDGBP 1000 --profile main-live --account TEST123 --sec-type CASH
  expect_fail order-prepare buy GBP.GBP 1000 --profile main-live --account TEST123 --sec-type CASH
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --currency GBP
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --exchange SMART
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --isin GB00BMBL1G81
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --outside-rth
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --type MKT
  expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 --sec-type CASH \
    --tif GTC
  expect_fail order-prepare buy GBP.USD 1000 --profile disabled-live --account TEST123 --sec-type CASH
  # The slippage cap belongs to currency conversion only; equities keep their own limit.
  expect_fail order-prepare buy AAPL 1 --profile main-live --account TEST123 --type LMT --limit 100 \
    --max-slippage-bps 20
  # Equities are unchanged: MKT and outside-RTH are still refused.
  expect_fail order-prepare buy AAPL 1 --profile main-live --account TEST123 --type MKT
  expect_fail order-prepare buy AAPL 1 --profile main-live --account TEST123 --type LMT --limit 100 \
    --outside-rth
  [[ ! -s "$FAKE_LOG" ]] || { echo 'FAIL: an invalid CASH request reached upstream' >&2; return 1; }

  # A stale reference (FX closed at weekends) is refused before any preview.
  FAKE_FX_BAR_AGE=901 expect_fail order-prepare buy GBP.USD 1000 --profile main-live \
    --account TEST123 --sec-type CASH
  grep -q 'reference rate for GBP.USD is stale' "$test_root/expected.err"
  FAKE_FX_BAR_AGE=-600 expect_fail order-prepare buy GBP.USD 1000 --profile main-live \
    --account TEST123 --sec-type CASH
  # The reference must be the requested conId and pair.
  FAKE_FX_CONID=1 expect_fail order-prepare buy GBP.USD 1000 --profile main-live \
    --account TEST123 --sec-type CASH --conid 12087797
  FAKE_FX_SYMBOL=EUR expect_fail order-prepare buy GBP.USD 1000 --profile main-live \
    --account TEST123 --sec-type CASH
  if grep -q -- '--preview' "$FAKE_LOG"; then
    echo 'FAIL: a CASH order was previewed without a fresh, matching reference' >&2
    return 1
  fi

  # A caller's --limit must lie inside [ref, cap] for BUY and [cap, ref] for SELL, on tick.
  ticket_id=$(fx_ticket fx_prepare buy --limit 1.3446)
  expect_fx_limit "$ticket_id" 1.3446
  jq -e '.order.fx.limitSource == "caller"' "$(fx_ticket_path "$ticket_id")" >/dev/null
  expect_fx_limit "$(fx_ticket fx_prepare buy --limit 1.345)" 1.345
  expect_fx_limit "$(fx_ticket fx_prepare sell --limit 1.3397)" 1.3397
  : >"$FAKE_LOG"
  for limit in 1.34505 1.3423 1.34401 2; do
    expect_fail order-prepare buy GBP.USD 1000 --profile main-live --account TEST123 \
      --sec-type CASH --limit "$limit"
    grep -q 'outside the 20 bp band' "$test_root/expected.err"
  done
  for limit in 1.34240 1.33965; do
    expect_fail order-prepare sell GBP.USD 1000 --profile main-live --account TEST123 \
      --sec-type CASH --limit "$limit"
  done
  if grep -q -- '--preview' "$FAKE_LOG"; then
    echo 'FAIL: an out-of-band CASH limit was previewed' >&2
    return 1
  fi

  # Submission is pinned to the previewed conId and pair.
  : >"$FAKE_LOG"
  ticket_id=$(fx_ticket fx_prepare buy)
  run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null
  submit_line=$(grep -- '--submit' "$FAKE_LOG")
  grep -q -- '^buy GBP.USD 1000 .*--exchange IDEALPRO --currency USD --sec-type CASH --conid 12087797 --type LMT --limit 1\.3450* --tif DAY --submit' \
    <<<"$submit_line"

  # A CASH ticket rewritten with a valid checksum is still refused when it no longer
  # matches its recorded pair, conId or band.
  local filter
  for filter in \
    '.order.limitPrice = 1.34505' \
    '.order.limitPrice = 1.3423' \
    '.order.limitPrice = 1.34401' \
    '.contract.conId = 1' \
    '.order.conId = 1' \
    '.order.fx.pair = "EUR.USD"' \
    '.order.symbol = "EUR.USD" | .order.fx.pair = "EUR.USD"' \
    '.contract.symbol = "EUR"' \
    '.contract.secType = "STK"' \
    '.order.secType = "STK"' \
    '.order.exchange = "SMART"' \
    '.order.currency = "GBP"' \
    '.order.fx.maxSlippageBps = 60' \
    '.order.fx.maxSlippageBps = 0' \
    '.order.fx.bandHigh = 1.36 | .order.limitPrice = 1.36' \
    '.order.fx.referenceRate = 1.3 | .order.fx.bandLow = 1.3' \
    '.order.fx.bandLow = 1.34 | .order.limitPrice = 1.34' \
    '.order.quantity = 1000.005' \
    '.order.action = "SELL"' \
    'del(.order.fx)'; do
    ticket_id=$(fx_ticket fx_prepare buy)
    rewrite_ticket "$ticket_id" "$filter"
    if run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null 2>"$test_root/expected.err"; then
      printf 'FAIL: tampered CASH ticket was submitted: %s\n' "$filter" >&2
      return 1
    fi
    grep -q 'prepared order ticket is malformed' "$test_root/expected.err" \
      || { printf 'FAIL: wrong refusal for %s: %s\n' "$filter" "$(cat "$test_root/expected.err")" >&2; return 1; }
  done
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 1 ]]
  # Control: a rewrite that changes nothing still submits, so the refusals above are the
  # band and pinning checks, not the rewrite itself.
  ticket_id=$(fx_ticket fx_prepare sell)
  rewrite_ticket "$ticket_id" '.'
  run_cli order-submit "$ticket_id" --confirm "$ticket_id" >/dev/null
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 2 ]]

  # A stock ticket cannot smuggle a CASH band in either.
  ticket_id=$(prepare_ticket)
  rewrite_ticket "$ticket_id" '.order.fx = {pair: "GBP.USD"}'
  expect_fail order-submit "$ticket_id" --confirm "$ticket_id"
  [[ "$(grep -c -- '--submit' "$FAKE_LOG")" == 2 ]]

  printf 'PASS: currency conversion band, stale-rate refusal and pinned submission\n'
}

case "${1:-all}" in
  prepare)
    run_prepare_tests
    ;;
  lifecycle)
    run_lifecycle_tests
    ;;
  bond)
    run_bond_tests
    ;;
  fx)
    run_fx_tests
    ;;
  all)
    run_prepare_tests
    run_lifecycle_tests
    run_bond_tests
    run_fx_tests
    ;;
  *)
    echo "unknown test group: $1" >&2
    exit 2
    ;;
esac
