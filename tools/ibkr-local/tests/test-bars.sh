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
        "isa": ["U00000001", "U00000002"]
      }
    }
  }
}
EOF

# Bars carry no account field, and upstream prints an upgrade banner on stdout ahead of the
# JSON -- both are what this command has to survive.
cat >"$test_root/bin/ibkr" <<'EOF'
#!/bin/sh
set -euo pipefail
printf '%s\n' "$*" >"$FAKE_IBKR_ARGS"
if [[ "${FAKE_IBKR_NOTICE:-0}" == 1 ]]; then
  printf 'A new version 9.9.9 is available (current: 0.7.1). Run "ibkr update" to upgrade.\n'
fi
cat <<'JSON'
{
  "symbol": "META",
  "bar_size": "5 mins",
  "bars": [
    {"time": "2026-08-26T12:55:00Z", "open": 1, "high": 2, "low": 1, "close": 2,
     "volume": 285028, "vwap": 1.5, "bar_count": 2581},
    {"time": "2026-08-26T13:00:00Z", "open": 2, "high": 3, "low": 2, "close": 3,
     "volume": 15000, "vwap": 2.5, "bar_count": 190}
  ]
}
JSON
EOF
# quoted heredoc cannot expand: set a resolvable interpreter here.
sed -i "1s|.*|#!$(command -v bash)|" "$test_root/bin/ibkr"
chmod +x "$test_root/bin/ibkr"

run_bars() {
  PATH="$test_root/bin:$PATH" \
    IBKR_UPSTREAM="$test_root/bin/ibkr" \
    IBKR_LOCAL_CONFIG_DIR="$test_root/config" \
    IBKR_LOCAL_PROFILES="$test_root/config/profiles.json" \
    FAKE_IBKR_ARGS="$test_root/args" \
    FAKE_IBKR_NOTICE="${FAKE_IBKR_NOTICE:-0}" \
    bash "$cli" bars "$@"
}

out=$(run_bars META --profile main-live --bar-size '5 mins' --all-hours)
[[ "$(jq -r '.bars | length' <<<"$out")" == 2 ]] \
  || { printf 'FAIL: bars payload did not survive the wrapper\n' >&2; exit 1; }
[[ "$(jq -r '.bars[0].bar_count' <<<"$out")" == 2581 ]] \
  || { printf 'FAIL: bar_count was lost\n' >&2; exit 1; }
grep -Fq -- 'bars META' "$test_root/args" \
  || { printf 'FAIL: symbol was not forwarded\n' >&2; exit 1; }
grep -Fq -- '--bar-size 5 mins' "$test_root/args" \
  || { printf 'FAIL: --bar-size was not forwarded\n' >&2; exit 1; }
grep -Fq -- '--all-hours' "$test_root/args" \
  || { printf 'FAIL: --all-hours was not forwarded\n' >&2; exit 1; }
grep -Fq -- '--profile main-live' "$test_root/args" \
  || { printf 'FAIL: --profile was not forwarded\n' >&2; exit 1; }
grep -Fq -- '--json' "$test_root/args" \
  || { printf 'FAIL: --json was not forwarded\n' >&2; exit 1; }
if grep -Fq -- '--account' "$test_root/args"; then
  printf 'FAIL: an account was forwarded to a non-account-scoped command\n' >&2
  exit 1
fi

with_notice=$(FAKE_IBKR_NOTICE=1 run_bars META --profile main-live)
[[ "$(jq -r '.bars | length' <<<"$with_notice")" == 2 ]] \
  || { printf 'FAIL: upgrade banner was not stripped before the JSON\n' >&2; exit 1; }

for bad in --account:U00000001 --group:isa; do
  flag=${bad%%:*}
  value=${bad##*:}
  if run_bars META --profile main-live "$flag" "$value" >/dev/null 2>&1; then
    printf 'FAIL: %s was accepted on a non-account-scoped command\n' "$flag" >&2
    exit 1
  fi
done

if run_bars --profile main-live >/dev/null 2>&1; then
  printf 'FAIL: bars without a symbol was accepted\n' >&2
  exit 1
fi

if run_bars META --profile main-live --submit >/dev/null 2>&1; then
  printf 'FAIL: order mutation was not blocked on bars\n' >&2
  exit 1
fi

printf 'PASS: bars forwarding, banner handling, account-scope refusal, and order safety\n'
