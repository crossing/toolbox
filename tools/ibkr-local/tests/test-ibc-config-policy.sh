#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
cli=$tool_dir/ibkr-local.sh
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

mkdir -p "$test_root/bin" "$test_root/runtime" "$test_root/config"

# Self-contained profile fixture. This test previously read whatever profiles.json
# happened to exist under the invoking user's $XDG_CONFIG_HOME, so it only passed on a
# machine with a live IBKR config and failed anywhere else -- including CI, where it had
# never been run. Fake account ids only: this repository is public.
cat >"$test_root/config/profiles.json" <<'EOF'
{
  "defaultProfile": "main-live",
  "accounts": {},
  "profiles": {
    "main-live": {
      "ibkrProfile": "main-live",
      "accounts": {
        "isa": ["U00000001"]
      }
    }
  }
}
EOF
cat >"$test_root/bin/safe-op" <<'EOF'
#!/bin/sh
set -euo pipefail
case "$2" in
  */username) printf 'test-user' ;;
  */password) printf 'test-password' ;;
  *) exit 2 ;;
esac
EOF
# quoted heredoc cannot expand: set a resolvable interpreter here.
sed -i "1s|.*|#!$(command -v bash)|" "$test_root/bin/safe-op"
chmod +x "$test_root/bin/safe-op"

result=$(
  PATH="$test_root/bin:$PATH" \
    IBKR_LOCAL_PROFILES="$test_root/config/profiles.json" \
    IBKR_IBC_RUNTIME_PARENT="$test_root/runtime" \
    bash "$cli" ibc-config \
      --profile main-live \
      --username-ref op://test/item/username \
      --password-ref op://test/item/password \
      --trading-mode live \
      --api-port 4005 \
      --allow-api-write
)
config=$(jq -r '.config' <<<"$result")

grep -qx 'AcceptIncomingConnectionAction=reject' "$config"
if grep -qx 'AcceptIncomingConnectionAction=accept' "$config"; then
  echo 'FAIL: rendered IBC config accepts unsolicited API prompts' >&2
  exit 1
fi

printf 'PASS: rendered IBC config rejects unsolicited API prompts\n'
