#!/usr/bin/env bash

# Unit tests for op-oauth2c

set -e

# Setup temporary environment
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Create mocks
mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"

# Mock 'op'
MOCK_OP="$TEST_DIR/bin/op"
cat > "$MOCK_OP" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"item get"* ]]; then
    if [[ "\$*" == *"client_id"* ]]; then
        echo "mock-client-id"
    elif [[ "\$*" == *"client_secret"* ]]; then
        echo "mock-client-secret"
    fi
elif [[ "\$*" == *"item edit"* ]]; then
    echo "mock-op: item edited with \$*" >&2
fi
EOF
chmod +x "$MOCK_OP"

# Mock 'safe-op' (just calls op)
MOCK_SAFE_OP="$TEST_DIR/bin/safe-op"
cat > "$MOCK_SAFE_OP" <<EOF
#!/usr/bin/env bash
exec op "\$@"
EOF
chmod +x "$MOCK_SAFE_OP"

# Mock 'oauth2c'
MOCK_OAUTH2C="$TEST_DIR/bin/oauth2c"
cat > "$MOCK_OAUTH2C" <<EOF
#!/usr/bin/env bash
echo '{"access_token": "mock-access-token", "refresh_token": "mock-refresh-token"}'
EOF
chmod +x "$MOCK_OAUTH2C"

# Mock 'jq' (using system jq)
# No need to mock jq if it's available, but let's ensure it's in PATH.

# The script we are testing
OP_OAUTH2C="./src/op-oauth2c.sh"
chmod +x "$OP_OAUTH2C"

echo "Running tests for op-oauth2c..."

# Run the script
# It should retrieve id/secret, run oauth2c, and edit the item twice.
OUTPUT=$("$OP_OAUTH2C" "my-item" "https://issuer.com" 2>&1)

echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "Successfully updated tokens in 1Password"; then
    echo "  Success: Script finished successfully."
else
    echo "  Failure: Script did not report success."
    exit 1
fi

if echo "$OUTPUT" | grep -q "mock-op: item edited with item edit my-item access_token\[text\]=mock-access-token"; then
    echo "  Success: access_token was saved."
else
    echo "  Failure: access_token save command not found."
    exit 1
fi

if echo "$OUTPUT" | grep -q "mock-op: item edited with item edit my-item refresh_token\[password\]=mock-refresh-token"; then
    echo "  Success: refresh_token was saved."
else
    echo "  Failure: refresh_token save command not found."
    exit 1
fi

echo "All op-oauth2c tests passed!"
