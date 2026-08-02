#!/usr/bin/env bash

# Unit tests for op-freeagent

set -e

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"

# The current access token lives in this file so the mocks can share state:
# mock op prints it, mock op-oauth2c replaces it with a fresh one.
export MOCK_TOKEN_FILE="$TEST_DIR/token"

cat > "$TEST_DIR/bin/op" <<EOF
#!$(command -v bash)
if [[ "\$*" == *"item get"* && "\$*" == *"access_token"* ]]; then
    echo "mock-op: \$*" >&2
    cat "\$MOCK_TOKEN_FILE"
fi
EOF
chmod +x "$TEST_DIR/bin/op"

cat > "$TEST_DIR/bin/safe-op" <<EOF
#!$(command -v bash)
exec op "\$@"
EOF
chmod +x "$TEST_DIR/bin/safe-op"

cat > "$TEST_DIR/bin/op-oauth2c" <<EOF
#!$(command -v bash)
echo "mock-op-oauth2c: \$*" >&2
printf 'fresh-token' > "\$MOCK_TOKEN_FILE"
EOF
chmod +x "$TEST_DIR/bin/op-oauth2c"

cat > "$TEST_DIR/bin/freeagent" <<EOF
#!$(command -v bash)
if [[ -n "\${MOCK_FREEAGENT_FAIL:-}" ]]; then
    echo "API error (status 500): Server Error" >&2
    exit 4
fi
if [[ "\${FREEAGENT_ACCESS_TOKEN:-}" == "fresh-token" ]]; then
    echo "{\"bills\":[]}"
    exit 0
fi
echo "API error (status 401): Unauthorized" >&2
exit 1
EOF
chmod +x "$TEST_DIR/bin/freeagent"

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
OP_FREEAGENT="$tool_dir/op-freeagent.sh"
[ -f "$OP_FREEAGENT" ] || { echo "cannot find op-freeagent.sh at $OP_FREEAGENT"; exit 1; }

echo "Running tests for op-freeagent..."

fail() {
    echo "  Failure: $1"
    echo "  --- captured output ---"
    echo "${OUTPUT:-<none>}"
    exit 1
}

export OP_FREEAGENT_ITEM="freeagent-item"

# 1. No item configured -> exit 3.
rc=0
OUTPUT=$(OP_FREEAGENT_ITEM="" bash "$OP_FREEAGENT" bills list 2>&1) || rc=$?
[ "$rc" -eq 3 ] || fail "expected exit 3 with no item configured, got $rc"
echo "  Success: unconfigured invocation is rejected."

# 2. Valid stored token -> runs without refreshing.
printf 'fresh-token' > "$MOCK_TOKEN_FILE"
OUTPUT=$(bash "$OP_FREEAGENT" bills list 2>&1)
echo "$OUTPUT" | grep -q '{"bills":\[\]}' || fail "freeagent output not passed through"
echo "$OUTPUT" | grep -q "mock-op-oauth2c" && fail "refresh ran despite valid token"
echo "  Success: valid token runs without refresh."

# 3. Stale token -> 401, refresh once, retry succeeds.
printf 'stale-token' > "$MOCK_TOKEN_FILE"
OUTPUT=$(bash "$OP_FREEAGENT" bills list 2>&1)
echo "$OUTPUT" | grep -q "status 401" || fail "first 401 not surfaced"
echo "$OUTPUT" | grep -q -- "mock-op-oauth2c: --refresh freeagent-item https://api.freeagent.com --token-endpoint https://api.freeagent.com/v2/token_endpoint" \
    || fail "op-oauth2c --refresh not invoked correctly"
echo "$OUTPUT" | grep -q '{"bills":\[\]}' || fail "retry after refresh did not succeed"
echo "  Success: 401 triggers one refresh and a successful retry."

# 4. No stored token -> refresh before the first run.
: > "$MOCK_TOKEN_FILE"
OUTPUT=$(bash "$OP_FREEAGENT" bills list 2>&1)
echo "$OUTPUT" | grep -q "No stored access token" || fail "missing-token path not taken"
echo "$OUTPUT" | grep -q '{"bills":\[\]}' || fail "run after seeding refresh did not succeed"
echo "  Success: missing token refreshes before running."

# 5. Non-auth failure -> no refresh, exit code preserved.
printf 'fresh-token' > "$MOCK_TOKEN_FILE"
rc=0
OUTPUT=$(MOCK_FREEAGENT_FAIL=1 bash "$OP_FREEAGENT" bills list 2>&1) || rc=$?
[ "$rc" -eq 4 ] || fail "expected freeagent's exit code 4, got $rc"
echo "$OUTPUT" | grep -q "mock-op-oauth2c" && fail "refresh ran on a non-auth failure"
echo "  Success: non-auth failures pass through untouched."

echo "All op-freeagent tests passed!"
