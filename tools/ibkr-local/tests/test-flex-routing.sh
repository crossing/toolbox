#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
cli=$tool_dir/ibkr-local.sh
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/capture" "$test_root/runtime"
secret_file="$test_root/runtime-secret"
printf 'runtime-secret-%s' "$$" >"$secret_file"

cat >"$test_root/profiles.json" <<'EOF'
{
  "defaultProfile": "main-live",
  "accounts": {},
  "profiles": {
    "main-live": {
      "ibkrProfile": "main-live",
      "accounts": {},
      "flex": {
        "tokenRef": "op://synthetic/main/token",
        "queries": {
          "tax-history": {"queryId": "100001"},
          "income": {"queryId": "100002"}
        }
      }
    },
    "single-live": {
      "ibkrProfile": "single-live",
      "accounts": {},
      "flex": {
        "tokenRef": "op://synthetic/single/token",
        "queries": {
          "activity": {"queryId": "100003"}
        }
      }
    },
    "empty-live": {
      "ibkrProfile": "empty-live",
      "accounts": {},
      "flex": {"tokenRef": null, "queries": {}}
    }
  }
}
EOF

cat >"$test_root/bin/safe-op" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == read && "$3" == --no-newline ]]
printf '%s' "$2" >"$CAPTURE_DIR/safe-op-ref"
printf '%s' "${XDG_RUNTIME_DIR:-}" >"$CAPTURE_DIR/safe-op-runtime"
if [[ "${SAFE_OP_TEST_MODE:-success}" == fail ]]; then
  printf 'unsafe diagnostic: '
  cat "$SECRET_FILE"
  exit 1
fi
cat "$SECRET_FILE"
EOF
sed -i "1s|.*|#!$(command -v bash)|" "$test_root/bin/safe-op"
chmod +x "$test_root/bin/safe-op"

cat >"$test_root/bin/ibkr-flex-fetch" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
token=$(cat)
expected=$(cat "$SECRET_FILE")
[[ "$token" == "$expected" ]] || exit 91
printf '%s\n' "$@" >"$CAPTURE_DIR/flex-args"
printf '%s' "${XDG_RUNTIME_DIR:-}" >"$CAPTURE_DIR/flex-runtime"
if [[ "${FLEX_TEST_MODE:-success}" == fail ]]; then
  printf 'unsafe diagnostic: %s\n' "$token" >&2
  exit 1
fi
printf '{"rows":[],"count":0}\n'
EOF
sed -i "1s|.*|#!$(command -v bash)|" "$test_root/bin/ibkr-flex-fetch"
chmod +x "$test_root/bin/ibkr-flex-fetch"

export PATH="$test_root/bin:$PATH"
export IBKR_LOCAL_PROFILES="$test_root/profiles.json"
export IBKR_LOCAL_XDG_CONFIG_HOME="$test_root/upstream-config"
export CAPTURE_DIR="$test_root/capture"
export SECRET_FILE="$secret_file"
export XDG_RUNTIME_DIR="$test_root/runtime"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

run_wrapper() {
  bash "$cli" "$@"
}

assert_file_equals() {
  local expected=$1 file=$2
  [[ "$(cat "$file")" == "$expected" ]] \
    || fail "$file did not contain the expected value"
}

assert_failure_contains() {
  local expected=$1
  shift
  local output status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail "command unexpectedly succeeded"
  [[ "$output" == *"$expected"* ]] || fail "failure did not contain: $expected"
  printf '%s' "$output"
}

rm -f "$CAPTURE_DIR"/*
run_wrapper flex-trades \
  --profile main-live \
  --flex-query tax-history \
  --account ACCOUNT_SYNTH_A \
  --from 2022-06-01 \
  --to 2026-05-05 \
  --json >/dev/null
assert_file_equals "op://synthetic/main/token" "$CAPTURE_DIR/safe-op-ref"
assert_file_equals "$XDG_RUNTIME_DIR" "$CAPTURE_DIR/safe-op-runtime"
assert_file_equals "$XDG_RUNTIME_DIR" "$CAPTURE_DIR/flex-runtime"
mapfile -t flex_args <"$CAPTURE_DIR/flex-args"
expected_args=(
  --query-id 100001
  --kind trades
  --account ACCOUNT_SYNTH_A
  --from-date 2022-06-01
  --to-date 2026-05-05
)
[[ "${flex_args[*]}" == "${expected_args[*]}" ]] || fail "explicit date arguments were routed incorrectly"

rm -f "$CAPTURE_DIR"/*
run_wrapper dividends --profile main-live --flex-query income --account ACCOUNT_SYNTH_B --days 500 >/dev/null
assert_file_equals "op://synthetic/main/token" "$CAPTURE_DIR/safe-op-ref"
mapfile -t flex_args <"$CAPTURE_DIR/flex-args"
end_date=$(date -I)
start_date=$(date -I -d "$end_date - 499 days")
expected_args=(
  --query-id 100002
  --kind dividends
  --account ACCOUNT_SYNTH_B
  --from-date "$start_date"
  --to-date "$end_date"
)
[[ "${flex_args[*]}" == "${expected_args[*]}" ]] || fail "--days compatibility routing was incorrect"

rm -f "$CAPTURE_DIR"/*
run_wrapper transfers --profile single-live --from 2026-01-01 --to 2026-01-31 >/dev/null
assert_file_equals "op://synthetic/single/token" "$CAPTURE_DIR/safe-op-ref"
grep -qx '100003' "$CAPTURE_DIR/flex-args" || fail "single configured query was not selected"
if grep -qx -- '--account' "$CAPTURE_DIR/flex-args"; then
  fail "account filtering was added when --account was omitted"
fi

rm -f "$CAPTURE_DIR"/*
run_wrapper flex-statement --profile main-live --flex-query tax-history --from 2025-04-06 --to 2026-04-05 --json >/dev/null
assert_file_equals "op://synthetic/main/token" "$CAPTURE_DIR/safe-op-ref"
mapfile -t flex_args <"$CAPTURE_DIR/flex-args"
expected_args=(
  --query-id 100001
  --kind raw
  --from-date 2025-04-06
  --to-date 2026-04-05
)
[[ "${flex_args[*]}" == "${expected_args[*]}" ]] || fail "flex-statement raw routing was incorrect"

rm -f "$CAPTURE_DIR"/*
run_wrapper flex-statement --profile single-live >/dev/null
mapfile -t flex_args <"$CAPTURE_DIR/flex-args"
end_date=$(date -I)
start_date=$(date -I -d "$end_date - 364 days")
expected_args=(
  --query-id 100003
  --kind raw
  --from-date "$start_date"
  --to-date "$end_date"
)
[[ "${flex_args[*]}" == "${expected_args[*]}" ]] || fail "flex-statement default 365-day window was incorrect"

rm -f "$CAPTURE_DIR"/*
assert_failure_contains \
  "--account is not supported for flex-statement" \
  run_wrapper flex-statement --profile single-live --account ACCOUNT_SYNTH_A >/dev/null
[[ ! -e "$CAPTURE_DIR/safe-op-ref" ]] || fail "safe-op ran before the flex-statement account rejection"

rm -f "$CAPTURE_DIR"/*
assert_failure_contains \
  "multiple Flex queries configured for profile main-live; pass --flex-query" \
  run_wrapper flex-trades --profile main-live --days 30 >/dev/null
[[ ! -e "$CAPTURE_DIR/safe-op-ref" ]] || fail "safe-op ran before ambiguous query selection was rejected"

assert_failure_contains \
  "no Flex query named missing configured for profile main-live" \
  run_wrapper flex-trades --profile main-live --flex-query missing --days 30 >/dev/null

assert_failure_contains \
  "no Flex queries configured for profile empty-live" \
  run_wrapper flex-trades --profile empty-live --days 30 >/dev/null

assert_failure_contains \
  "--group is not supported for Flex history" \
  run_wrapper flex-trades --profile single-live --group isa --days 30 >/dev/null

rm -f "$CAPTURE_DIR"/*
SAFE_OP_TEST_MODE=fail
export SAFE_OP_TEST_MODE
safe_op_output=$(assert_failure_contains \
  "unable to retrieve Flex token from 1Password for profile single-live" \
  run_wrapper flex-trades --profile single-live --days 30)
runtime_secret=$(cat "$secret_file")
[[ "$safe_op_output" != *"$runtime_secret"* ]] || fail "safe-op failure leaked the runtime secret"
unset SAFE_OP_TEST_MODE

rm -f "$CAPTURE_DIR"/*
FLEX_TEST_MODE=fail
export FLEX_TEST_MODE
flex_output=$(assert_failure_contains \
  "Flex history request failed for profile single-live" \
  run_wrapper flex-trades --profile single-live --days 30)
[[ "$flex_output" != *"$runtime_secret"* ]] || fail "Flex helper failure leaked the runtime secret"
unset FLEX_TEST_MODE

rm -f "$CAPTURE_DIR"/*
run_wrapper config show >/dev/null
[[ ! -e "$CAPTURE_DIR/safe-op-ref" ]] || fail "non-Flex command invoked safe-op"

printf 'PASS: profile Flex query routing, account filtering, and redaction\n'
