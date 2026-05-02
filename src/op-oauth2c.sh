#!/usr/bin/env bash

# op-oauth2c: OAuth2 flow with 1Password integration
# Usage: op-oauth2c <1password-item> <oauth-issuer-url>

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: op-oauth2c <1password-item> <oauth-issuer-url> [additional-oauth2c-flags...]" >&2
    exit 1
fi

ITEM="$1"
ISSUER="$2"
shift 2

# Check for dependencies
for cmd in jq oauth2c op; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: Required command '$cmd' not found." >&2
        exit 1
    fi
done

# We use safe-op if available, otherwise fall back to op.
# Command substitution is required for security.
OP_CMD="op"
if command -v safe-op &> /dev/null; then
    OP_CMD="safe-op"
fi

echo "Retrieving client credentials from 1Password item: $ITEM" >&2
CLIENT_ID=$($OP_CMD item get "$ITEM" --field label=client_id)
CLIENT_SECRET=$($OP_CMD item get "$ITEM" --field label=client_secret)

if [[ -z "$CLIENT_ID" ]] || [[ -z "$CLIENT_SECRET" ]]; then
    echo "Error: Could not find client_id or client_secret in item '$ITEM'." >&2
    exit 1
fi

echo "Starting OAuth2 flow for $ISSUER..." >&2
# Run oauth2c. It will output JSON to stdout.
# We pass through any additional flags.
TOKEN_JSON=$(oauth2c "$ISSUER" --client-id "$CLIENT_ID" --client-secret "$CLIENT_SECRET" "$@")

if [[ -z "$TOKEN_JSON" ]]; then
    echo "Error: oauth2c produced no output." >&2
    exit 1
fi

# Extract tokens using jq
ACCESS_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.access_token')
REFRESH_TOKEN=$(echo "$TOKEN_JSON" | jq -r '.refresh_token // empty')

if [[ "$ACCESS_TOKEN" == "null" ]] || [[ -z "$ACCESS_TOKEN" ]]; then
    echo "Error: Failed to parse access_token from oauth2c output." >&2
    echo "Output was: $TOKEN_JSON" >&2
    exit 1
fi

echo "Updating 1Password item '$ITEM' with new tokens..." >&2
# Update or create fields for the tokens.
# Using label[text]=... syntax for op item edit.
op item edit "$ITEM" "access_token[text]=$ACCESS_TOKEN" > /dev/null

if [[ -n "$REFRESH_TOKEN" ]] && [[ "$REFRESH_TOKEN" != "null" ]]; then
    op item edit "$ITEM" "refresh_token[password]=$REFRESH_TOKEN" > /dev/null
fi

echo "Successfully updated tokens in 1Password." >&2
