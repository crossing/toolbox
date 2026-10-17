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

# File-backed credentials (sops-nix): rendering must not touch 1Password at all.
mkdir -p "$test_root/nobin" "$test_root/secrets"
printf '#!%s\necho "safe-op must not run for file credentials" >&2\nexit 99\n' \
  "$(command -v bash)" >"$test_root/nobin/safe-op"
chmod +x "$test_root/nobin/safe-op"
printf 'file-user' >"$test_root/secrets/username"
printf 'file-password\n' >"$test_root/secrets/password"
chmod 400 "$test_root/secrets/username" "$test_root/secrets/password"

render_from_files() {
  PATH="$test_root/nobin:$PATH" \
    IBKR_LOCAL_PROFILES="$test_root/config/profiles.json" \
    IBKR_IBC_RUNTIME_PARENT="$test_root/runtime" \
    bash "$cli" ibc-config \
      --profile main-live \
      --trading-mode live \
      --api-port 4005 \
      "$@"
}

result=$(render_from_files \
  --username-file "$test_root/secrets/username" \
  --password-file "$test_root/secrets/password")
config=$(jq -r '.config' <<<"$result")
grep -qx 'IbLoginId=file-user' "$config"
grep -qx 'IbPassword=file-password' "$config"
printf 'PASS: file credentials render without 1Password\n'

chmod 644 "$test_root/secrets/password"
if render_from_files \
  --username-file "$test_root/secrets/username" \
  --password-file "$test_root/secrets/password" >/dev/null 2>&1; then
  echo 'FAIL: world-readable password file was accepted' >&2
  exit 1
fi
chmod 400 "$test_root/secrets/password"
printf 'PASS: credential files must be owner-only\n'

if render_from_files \
  --username-file "$test_root/secrets/username" \
  --password-file "$test_root/secrets/password" \
  --password-ref op://test/item/password >/dev/null 2>&1; then
  echo 'FAIL: --password-file combined with --password-ref was accepted' >&2
  exit 1
fi
printf 'PASS: file and 1Password sources are mutually exclusive\n'
