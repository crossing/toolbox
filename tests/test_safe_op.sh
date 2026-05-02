#!/usr/bin/env bash

# Unit tests for safe-op

set -e

# Setup temporary environment
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Create a mock 'op' binary
MOCK_OP="$TEST_DIR/op"
cat > "$MOCK_OP" <<EOF
#!/usr/bin/env bash
echo "mock-output-of-op \$*"
EOF
chmod +x "$MOCK_OP"

# Prepare PATH so safe-op finds our mock op
export PATH="$TEST_DIR:$PATH"

# The script we are testing
SAFE_OP="./src/safe-op.sh"
chmod +x "$SAFE_OP"

echo "Running tests for safe-op..."

# Test 1: Command substitution should succeed (stdout is a pipe)
echo "Test 1: Command substitution..."
RESULT=$( "$SAFE_OP" item get my-secret )
if [[ "$RESULT" == *"mock-output-of-op item get my-secret"* ]]; then
    echo "  Success: Result matched expected mock output."
else
    echo "  Failure: Result did not match. Got: $RESULT"
    exit 1
fi

# Test 2: Direct terminal output should fail (stdout is a TTY/not a pipe)
# We can simulate a non-pipe by just running it normally in this script
# since this script's stdout is probably a TTY or a file redirection if piped.
# To be sure we test "not a pipe", we can redirect to a file.
echo "Test 2: Terminal/File output should fail..."
if "$SAFE_OP" item get my-secret > "$TEST_DIR/out" 2> "$TEST_DIR/err"; then
    echo "  Failure: Command succeeded but should have been blocked."
    exit 1
else
    if grep -q "CRITICAL SECURITY BLOCK" "$TEST_DIR/err"; then
        echo "  Success: Correct error message found in stderr."
    else
        echo "  Failure: Error message not found. Stderr: $(cat "$TEST_DIR/err")"
        exit 1
    fi
fi

# Test 3: Non-secret command should succeed anywhere
echo "Test 3: Non-secret command (whoami) should succeed..."
RESULT_WHOAMI=$( "$SAFE_OP" whoami )
if [[ "$RESULT_WHOAMI" == *"mock-output-of-op whoami"* ]]; then
    echo "  Success: whoami passed through."
else
    echo "  Failure: whoami failed. Got: $RESULT_WHOAMI"
    exit 1
fi

echo "All safe-op tests passed!"
