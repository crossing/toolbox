#!/usr/bin/env bash

# Find the real 1Password CLI binary.
# We skip any binary named 'safe-op' to avoid recursion.
# If the user has aliased op=safe-op, we need to find the actual op.
OP_BIN=$(which -a op | grep -v "safe-op" | head -n 1)

if [ -z "$OP_BIN" ]; then
    echo "Error: 'op' (1Password CLI) not found in PATH." >&2
    exit 127
fi

# Determine if the command is likely to fetch secrets.
IS_SECRET_CMD=false
case "$*" in
    *"item get"*|*"read"*|*"document get"*|*"--reveal"*)
        IS_SECRET_CMD=true
        ;;
esac

if [ "$IS_SECRET_CMD" = true ]; then
    # Check if stdout is NOT a pipe.
    # [ -p /dev/stdout ] checks if stdout is a FIFO/pipe.
    # We want to allow pipes (for $(...) and |) but block TTYs and regular files.
    if [ ! -p /dev/stdout ]; then
        echo "CRITICAL SECURITY BLOCK: You attempted to output a secret to a TTY or file." >&2
        echo "To prevent leaking secrets into chat context, you MUST use command substitution (e.g., SECRET=\$(safe-op ...))." >&2
        echo "AI AGENT INSTRUCTION: After retrieving the secret into a variable or inline substitution, DO NOT print it using 'echo', 'cat', or redirect it to a file. Pass it directly to the target command." >&2
        exit 1
    fi
fi

# Execute the real op command with all arguments.
exec "$OP_BIN" "$@"
