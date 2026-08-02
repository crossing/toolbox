#!/usr/bin/env bash

# op-freeagent: run freeagent with the access token held in a 1Password item,
# refreshing it via `op-oauth2c --refresh` when FreeAgent rejects it.
#
# Usage: op-freeagent <freeagent args...>
#
# Configuration (baked in by package.nix, environment always wins):
#   OP_FREEAGENT_ITEM            1Password item with client_id/client_secret/tokens
#   OP_FREEAGENT_ISSUER          issuer passed to op-oauth2c
#   OP_FREEAGENT_TOKEN_ENDPOINT  OAuth token endpoint (FreeAgent has no discovery doc)

set -euo pipefail

: "${OP_FREEAGENT_ITEM:=}"
: "${OP_FREEAGENT_ISSUER:=https://api.freeagent.com}"
: "${OP_FREEAGENT_TOKEN_ENDPOINT:=https://api.freeagent.com/v2/token_endpoint}"

if [[ -z "$OP_FREEAGENT_ITEM" ]]; then
    echo "Error: no 1Password item configured. Set OP_FREEAGENT_ITEM or bake one in via the package's 'item' argument." >&2
    exit 3
fi

if [[ $# -lt 1 ]]; then
    echo "Usage: op-freeagent <freeagent args...>" >&2
    exit 3
fi

for cmd in freeagent op-oauth2c op; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: Required command '$cmd' not found." >&2
        exit 1
    fi
done

# We use safe-op for reads if available, otherwise fall back to op.
OP_CMD="op"
if command -v safe-op &> /dev/null; then
    OP_CMD="safe-op"
fi

read_token() {
    $OP_CMD item get "$OP_FREEAGENT_ITEM" --field label=access_token
}

refresh_tokens() {
    op-oauth2c --refresh "$OP_FREEAGENT_ITEM" "$OP_FREEAGENT_ISSUER" \
        --token-endpoint "$OP_FREEAGENT_TOKEN_ENDPOINT" \
        --auth-method client_secret_basic
}

STDERR_FILE=$(mktemp)
trap 'rm -f "$STDERR_FILE"' EXIT

# Buffer stderr so a 401 can be detected without polluting the transcript twice;
# stdout streams through untouched.
run_freeagent() {
    local rc=0
    set +e
    FREEAGENT_ACCESS_TOKEN="$1" freeagent "${ARGS[@]}" 2> "$STDERR_FILE"
    rc=$?
    set -e
    cat "$STDERR_FILE" >&2
    return "$rc"
}

ARGS=("$@")

TOKEN=$(read_token || true)
if [[ -z "$TOKEN" ]]; then
    echo "No stored access token in '$OP_FREEAGENT_ITEM'; refreshing..." >&2
    refresh_tokens
    TOKEN=$(read_token)
fi

rc=0
run_freeagent "$TOKEN" || rc=$?

if [[ "$rc" -ne 0 ]] && grep -q "status 401" "$STDERR_FILE"; then
    echo "FreeAgent rejected the token (401); refreshing and retrying once..." >&2
    refresh_tokens
    TOKEN=$(read_token)
    rc=0
    run_freeagent "$TOKEN" || rc=$?
fi

exit "$rc"
