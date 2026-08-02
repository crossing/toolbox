#!/usr/bin/env bash

# Unit tests for op-gws-onboard

set -e

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"

# A fake OAuth client config to be copied into the throwaway gws config dir.
printf '{"installed":{"client_id":"file-cid","client_secret":"file-csec"}}' > "$TEST_DIR/client_secret.json"
export OP_GWS_ONBOARD_CLIENT_CONFIG="$TEST_DIR/client_secret.json"

# Mock 'gws'. Login asserts the throwaway config dir got the client config; export
# honours --unmasked unless MOCK_MASKED forces masked output (to test the guard).
LONG_RT=$(printf 'r%.0s' $(seq 1 100))
cat > "$TEST_DIR/bin/gws" <<EOF
#!$(command -v bash)
if [[ "\$1 \$2" == "auth login" ]]; then
    echo "mock-gws login: config_dir_set=\${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:+yes} keyring=\${GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:-unset} client_config_copied=\$([ -f "\$GOOGLE_WORKSPACE_CLI_CONFIG_DIR/client_secret.json" ] && echo yes || echo no) extra_args=\${3:-none}" >&2
elif [[ "\$1 \$2" == "auth export" ]]; then
    if [[ "\$*" == *"--unmasked"* && -z "\${MOCK_MASKED:-}" ]]; then
        echo "{\"client_id\":\"mock-cid\",\"client_secret\":\"mock-csec\",\"refresh_token\":\"$LONG_RT\"}"
    else
        echo '{"client_id":"mock-cid","client_secret":"GOCS...xyz","refresh_token":"1//ab...yz"}'
    fi
fi
EOF
chmod +x "$TEST_DIR/bin/gws"

cat > "$TEST_DIR/bin/op" <<EOF
#!$(command -v bash)
echo "mock-op: \$*" >&2
EOF
chmod +x "$TEST_DIR/bin/op"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
ONBOARD="$tool_dir/op-gws-onboard.sh"
[ -f "$ONBOARD" ] || { echo "cannot find op-gws-onboard.sh at $ONBOARD"; exit 1; }

echo "Running tests for op-gws-onboard..."

fail() {
    echo "  Failure: $1"
    echo "  --- captured output ---"
    echo "${OUTPUT:-<none>}"
    exit 1
}

# 1. No arguments -> usage, exit 3.
rc=0
OUTPUT=$(bash "$ONBOARD" 2>&1) || rc=$?
[ "$rc" -eq 3 ] || fail "expected exit 3 without arguments, got $rc"
echo "  ok: usage error"

# 2. Happy path: throwaway config dir seeded, unmasked export harvested into gws_ fields.
OUTPUT=$(bash "$ONBOARD" my-item --readonly 2>&1)
echo "$OUTPUT" | grep -q "mock-gws login: config_dir_set=yes keyring=file client_config_copied=yes extra_args=--readonly" \
    || fail "login did not run in seeded throwaway config dir"
echo "$OUTPUT" | grep -q "mock-op: item edit my-item gws_client_id\[text\]=mock-cid gws_client_secret\[password\]=mock-csec gws_refresh_token\[password\]=r" \
    || fail "harvested credentials not written to the item"
echo "$OUTPUT" | grep -q "Stored gws credentials" || fail "success message missing"
echo "  ok: happy path"

# 3. Masked export -> refused, nothing written, exit 2.
rc=0
OUTPUT=$(MOCK_MASKED=1 bash "$ONBOARD" my-item 2>&1) || rc=$?
[ "$rc" -eq 2 ] || fail "expected exit 2 on masked export, got $rc"
echo "$OUTPUT" | grep -q "looks masked" || fail "masked export not diagnosed"
echo "$OUTPUT" | grep -q "mock-op: item edit" && fail "masked credentials were written"
echo "  ok: masked export refused"

# 4. Missing client config -> exit 2.
rc=0
OUTPUT=$(OP_GWS_ONBOARD_CLIENT_CONFIG="$TEST_DIR/nope.json" bash "$ONBOARD" my-item 2>&1) || rc=$?
[ "$rc" -eq 2 ] || fail "expected exit 2 without client config, got $rc"
echo "$OUTPUT" | grep -q "no OAuth client config" || fail "missing config not diagnosed"
echo "  ok: missing client config"

echo "All op-gws-onboard tests passed!"
