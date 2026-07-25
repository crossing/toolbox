#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
cli=$tool_dir/ibkr-local.sh
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/config"
cat >"$test_root/config/profiles.json" <<'EOF'
{
  "defaultProfile": "main-live",
  "accounts": {},
  "profiles": {
    "main-live": {
      "ibkrProfile": "main-live",
      "accounts": {
        "isa": ["U00000001", "U00000002", "U00000003"]
      }
    },
    "pension-live": {
      "ibkrProfile": "pension-live",
      "accounts": {
        "pension": ["U00000004"]
      }
    }
  }
}
EOF

cat >"$test_root/bin/ibkr" <<'EOF'
#!/bin/sh
set -euo pipefail
printf '%s\n' "$*" >"$FAKE_IBKR_ARGS"
if [[ "${FAKE_IBKR_NOTICE:-0}" == 1 ]]; then
  printf 'A new version 9.9.9 is available (current: 0.7.1). Run "ibkr update" to upgrade.\n'
fi
cat <<'JSON'
{
  "managed_accounts": ["U00000001", "U00000002", "U00000003", "U00000004"],
  "selected_account": "U00000002",
  "rows": [
    {"account": "U00000001", "tag": "NetLiquidation", "value": "100", "currency": "GBP"},
    {"account": "U00000002", "tag": "NetLiquidation", "value": "200", "currency": "GBP"},
    {"account": "U00000004", "tag": "NetLiquidation", "value": "400", "currency": "GBP"}
  ]
}
JSON
EOF
# quoted heredoc cannot expand: set a resolvable interpreter here.
sed -i "1s|.*|#!$(command -v bash)|" "$test_root/bin/ibkr"
chmod +x "$test_root/bin/ibkr"

run_wrapper() {
  PATH="$test_root/bin:$PATH" \
    IBKR_UPSTREAM="$test_root/bin/ibkr" \
    IBKR_LOCAL_CONFIG_DIR="$test_root/config" \
    IBKR_LOCAL_PROFILES="$test_root/config/profiles.json" \
    FAKE_IBKR_ARGS="$test_root/args" \
    FAKE_IBKR_NOTICE="${1:-0}" \
    bash "$cli" balances --profile main-live --account U00000002
}

without_notice=$(run_wrapper 0)
[[ "$(jq -r '.rows | length' <<<"$without_notice")" == 1 ]] \
  || { printf 'FAIL: account filtering without update notice\n' >&2; exit 1; }
[[ "$(jq -r '.rows[0].account' <<<"$without_notice")" == U00000002 ]] \
  || { printf 'FAIL: wrong account without update notice\n' >&2; exit 1; }
grep -Fq -- '--account U00000002' "$test_root/args" \
  || { printf 'FAIL: --account was not forwarded to upstream account summary\n' >&2; exit 1; }

for command in positions executions; do
  PATH="$test_root/bin:$PATH" \
    IBKR_UPSTREAM="$test_root/bin/ibkr" \
    IBKR_LOCAL_CONFIG_DIR="$test_root/config" \
    IBKR_LOCAL_PROFILES="$test_root/config/profiles.json" \
    FAKE_IBKR_ARGS="$test_root/args" \
    bash "$cli" "$command" --profile main-live --account U00000002 >/dev/null
  grep -Fq -- '--account U00000002' "$test_root/args" \
    || { printf 'FAIL: --account was not forwarded for %s\n' "$command" >&2; exit 1; }
done

with_notice=$(run_wrapper 1)
[[ "$(jq -r '.rows | length' <<<"$with_notice")" == 1 ]] \
  || { printf 'FAIL: account filtering with update notice\n' >&2; exit 1; }
[[ "$(jq -r '.rows[0].account' <<<"$with_notice")" == U00000002 ]] \
  || { printf 'FAIL: wrong account with update notice\n' >&2; exit 1; }

if bash "$cli" order-preview buy AAPL 1 --profile main-live --submit >/dev/null 2>&1; then
  printf 'FAIL: order mutation was not blocked\n' >&2
  exit 1
fi

printf 'PASS: read-only account forwarding, JSON preamble handling, and order safety\n'
