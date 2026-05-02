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
echo "mock-output: \$*"
EOF
chmod +x "$MOCK_OP"

# Prepare PATH so safe-op finds our mock op
export PATH="$TEST_DIR:$PATH"

# The script we are testing
SAFE_OP="./src/safe-op.sh"
chmod +x "$SAFE_OP"

echo "Running tests for safe-op..."

# Helper to run test and check result
# run_test <expected_success_true_false> <command_args...>
run_test() {
    expected_success=$1
    shift
    args=("$@")
    
    echo "Testing: safe-op ${args[*]}"
    
    if [ "$expected_success" = true ]; then
        if ! "$SAFE_OP" "${args[@]}" > "$TEST_DIR/out" 2> "$TEST_DIR/err"; then
            echo "  Failure: Command failed but should have succeeded."
            echo "  Stderr: $(cat "$TEST_DIR/err")"
            exit 1
        fi
        echo "  Success: Command allowed."
    else
        if "$SAFE_OP" "${args[@]}" > "$TEST_DIR/out" 2> "$TEST_DIR/err"; then
            echo "  Failure: Command succeeded but should have been blocked."
            exit 1
        fi
        if grep -q "CRITICAL SECURITY BLOCK" "$TEST_DIR/err"; then
            echo "  Success: Command blocked with correct error message."
        else
            echo "  Failure: Error message not found. Stderr: $(cat "$TEST_DIR/err")"
            exit 1
        fi
    fi
}

# Test Cases:

# 1. Non-secret field (username) - Should be ALLOWED in terminal
run_test true item get my-item --field username

# 2. Secret field (password) - Should be BLOCKED in terminal
run_test false item get my-item --field password

# 3. Secret field via -f - Should be BLOCKED in terminal
run_test false item get my-item -f password

# 4. Secret field with case variation - Should be BLOCKED
run_test false item get my-item --field=Password

# 5. Using --reveal - Should be BLOCKED
run_test false item get my-item --reveal

# 6. Using read - Should be BLOCKED
run_test false read op://vault/item/field

# 7. No field, no reveal (masked summary) - Should be ALLOWED
run_test true item get my-item

# 8. Command substitution (even for secret) - Should be ALLOWED (simulated by piping to cat)
echo "Testing: \$(safe-op item get my-item --field password) (piped to cat)"
if ! "$SAFE_OP" item get my-item --field password | cat > /dev/null; then
    echo "  Failure: Piped command failed but should have been allowed."
    exit 1
fi
echo "  Success: Piped command allowed."

echo "All safe-op tests passed!"
