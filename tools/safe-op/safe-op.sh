#!/usr/bin/env bash

# Find the real 1Password CLI binary, skipping ourselves if we are named `op` on PATH.
#
# `type -aP` is a bash builtin, unlike `which`, which lives in its own package and was
# not in runtimeInputs -- so the packaged binary died with "which: command not found" on
# any PATH that lacked it. It only appeared to work because interactive shells have it.
#
# The `|| true` matters: writeShellApplication runs under `set -euo pipefail`, so a
# failed lookup would abort here instead of reaching the readable error below.
OP_BIN=$(type -aP op 2>/dev/null | grep -v "safe-op" | head -n 1 || true)

if [ -z "$OP_BIN" ]; then
    echo "Error: 'op' (1Password CLI) not found in PATH." >&2
    exit 127
fi

IS_SECRET_CMD=false
REVEAL_PRESENT=false
READ_OR_DOC_PRESENT=false
SENSITIVE_FIELD_PRESENT=false

# Loop through arguments to detect secret retrieval.
i=1
while [ $i -le $# ]; do
    arg="${!i}"
    case "$arg" in
        read|document)
            READ_OR_DOC_PRESENT=true
            ;;
        --reveal|--no-masking)
            REVEAL_PRESENT=true
            ;;
        --field|-f)
            next_i=$((i + 1))
            if [ $next_i -le $# ]; then
                field_val="${!next_i}"
                # Case-insensitive check for sensitive keywords
                case "${field_val,,}" in
                    *password*|*secret*|*token*|*key*|*credential*|*private*|*api*|*auth*)
                        SENSITIVE_FIELD_PRESENT=true
                        ;;
                esac
            fi
            ;;
        --field=*)
            field_val="${arg#*=}"
            case "${field_val,,}" in
                *password*|*secret*|*token*|*key*|*credential*|*private*|*api*|*auth*)
                    SENSITIVE_FIELD_PRESENT=true
                    ;;
            esac
            ;;
        -f=*)
            field_val="${arg#*=}"
            case "${field_val,,}" in
                *password*|*secret*|*token*|*key*|*credential*|*private*|*api*|*auth*)
                    SENSITIVE_FIELD_PRESENT=true
                    ;;
            esac
            ;;
    esac
    i=$((i + 1))
done

# Decide if this is a secret command.
if [ "$READ_OR_DOC_PRESENT" = true ] || [ "$REVEAL_PRESENT" = true ] || [ "$SENSITIVE_FIELD_PRESENT" = true ]; then
    IS_SECRET_CMD=true
fi

if [ "$IS_SECRET_CMD" = true ]; then
    # Block if stdout is NOT a pipe.
    if [ ! -p /dev/stdout ]; then
        echo "CRITICAL SECURITY BLOCK: You attempted to output a secret to a TTY or file." >&2
        echo "To prevent leaking secrets into chat context, you MUST use command substitution (e.g., SECRET=\$(safe-op ...))." >&2
        echo "AI AGENT INSTRUCTION: After retrieving the secret into a variable or inline substitution, DO NOT print it using 'echo', 'cat', or redirect it to a file. Pass it directly to the target command." >&2
        exit 1
    fi
fi

# Execute the real op command.
exec "$OP_BIN" "$@"
