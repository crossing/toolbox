#!/usr/bin/env bash

# Unit tests for op-gws

set -e

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"

# Mock 'op'. Emits an item JSON whose token fields are controlled by
# MOCK_TOKEN_FIELDS so tests can simulate cached-valid and expired states.
cat > "$TEST_DIR/bin/op" <<EOF
#!$(command -v bash)
if [[ "\$*" == *"item get"* ]]; then
    echo "mock-op: \$*" >&2
    cat <<JSON
{"fields":[
  {"label":"client_id","value":"mock-client-id"},
  {"label":"client_secret","value":"mock-client-secret"},
  {"label":"refresh_token","value":"mock-refresh-token"}
  \${MOCK_TOKEN_FIELDS:-}
]}
JSON
elif [[ "\$*" == *"item edit"* ]]; then
    echo "mock-op: item edited with \$*" >&2
fi
EOF
chmod +x "$TEST_DIR/bin/op"

cat > "$TEST_DIR/bin/safe-op" <<EOF
#!$(command -v bash)
exec op "\$@"
EOF
chmod +x "$TEST_DIR/bin/safe-op"

cat > "$TEST_DIR/bin/curl" <<EOF
#!$(command -v bash)
echo "mock-curl: \$*" >&2
echo '{"access_token":"minted-token","expires_in":3600}'
EOF
chmod +x "$TEST_DIR/bin/curl"

cat > "$TEST_DIR/bin/gws" <<EOF
#!$(command -v bash)
echo "mock-gws: token=\${GOOGLE_WORKSPACE_CLI_TOKEN:-unset} args=\$*"
EOF
chmod +x "$TEST_DIR/bin/gws"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
OP_GWS="$tool_dir/op-gws.sh"
[ -f "$OP_GWS" ] || { echo "cannot find op-gws.sh at $OP_GWS"; exit 1; }

echo "Running tests for op-gws..."

fail() {
    echo "  Failure: $1"
    echo "  --- captured output ---"
    echo "${OUTPUT:-<none>}"
    exit 1
}

# 1. No configuration at all -> usage error.
if OUTPUT=$(bash "$OP_GWS" drive files list 2>&1); then
    fail "expected non-zero exit with no item configured"
fi
echo "$OUTPUT" | grep -q "no 1Password item resolved" || fail "missing no-item error"
echo "  Success: unconfigured invocation is rejected."

# 2. Direct item, no cached token -> mints via curl, saves, execs gws.
OUTPUT=$(OP_GWS_ITEM="my-item" bash "$OP_GWS" drive files list 2>&1)
echo "$OUTPUT" | grep -q "mock-curl: .*grant_type=refresh_token" || fail "curl refresh grant not called"
echo "$OUTPUT" | grep -q "mock-curl: .*refresh_token=mock-refresh-token" || fail "stored refresh token not sent"
echo "$OUTPUT" | grep -q "mock-op: item edited with item edit my-item access_token\[password\]=minted-token" \
    || fail "minted token not saved"
echo "$OUTPUT" | grep -q "mock-gws: token=minted-token args=drive files list" || fail "gws not exec'd with minted token"
echo "  Success: expired/missing token is refreshed and cached."

# 3. Cached token still valid -> no curl call, cached token used.
export MOCK_TOKEN_FIELDS=',{"label":"access_token","value":"cached-token"},{"label":"expires_at","value":"9999999999"}'
OUTPUT=$(OP_GWS_ITEM="my-item" bash "$OP_GWS" drive files list 2>&1)
echo "$OUTPUT" | grep -q "mock-curl" && fail "curl called despite valid cached token"
echo "$OUTPUT" | grep -q "mock-gws: token=cached-token args=drive files list" || fail "cached token not used"
echo "  Success: valid cached token is reused without a network call."

# 4. Account resolution: leading account argument selects its item and is consumed.
OUTPUT=$(OP_GWS_ITEMS="work=gws-work,personal=gws-personal" \
    bash "$OP_GWS" personal gmail users messages list 2>&1)
echo "$OUTPUT" | grep -q "mock-op: item get gws-personal --format json" || fail "account arg did not select its item"
echo "$OUTPUT" | grep -q "mock-gws: token=cached-token args=gmail users messages list" \
    || fail "account arg was not consumed before gws"
echo "  Success: account argument resolves and is consumed."

# 5. Default account used when first arg is not an account name.
OUTPUT=$(OP_GWS_ITEMS="work=gws-work,personal=gws-personal" OP_GWS_DEFAULT_ACCOUNT="work" \
    bash "$OP_GWS" drive files list 2>&1)
echo "$OUTPUT" | grep -q "mock-op: item get gws-work --format json" || fail "default account not used"
echo "$OUTPUT" | grep -q "mock-gws: token=cached-token args=drive files list" || fail "args not passed through"
echo "  Success: default account fallback works."

# 6. Vault scoping is passed to op.
OUTPUT=$(OP_GWS_ITEM="my-item" OP_GWS_VAULT="Private" bash "$OP_GWS" drive files list 2>&1)
echo "$OUTPUT" | grep -q "mock-op: item get my-item --vault Private --format json" || fail "vault not passed to op"
echo "  Success: vault scoping is applied."
unset MOCK_TOKEN_FIELDS

echo "All op-gws tests passed!"
