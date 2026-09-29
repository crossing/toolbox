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
case " $* " in
  *' --sec-type BOND '*)
    sec_type=BOND
    con_id=${FAKE_BOND_CONID:-900000001}
    FAKE_ISIN=${FAKE_ISIN:-'"GB00BMBL1G81"'}
    ;;
esac

case " $* " in
  *' --preview '*)
    cat <<JSON
{
  "profile": "main-live",
  "preview_only": true,
  "selected_account": "TEST123",
  "symbol": "AAPL",
  "local_symbol": "AAPL",
  "exchange": "SMART",
  "primary_exchange": "NASDAQ",
  "currency": "USD",
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
  all)
    run_prepare_tests
    run_lifecycle_tests
    run_bond_tests
    ;;
  *)
    echo "unknown test group: $1" >&2
    exit 2
    ;;
esac
