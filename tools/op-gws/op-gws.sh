#!/usr/bin/env bash

# op-gws: run gws with an access token minted from Google OAuth credentials held in
# 1Password. One 1Password item per Google account; nothing touches disk.
#
# Usage: op-gws [<account>] <gws args...>
#        op-gws --accounts            list configured accounts as JSON
#
# Configuration (baked in by package.nix, environment always wins):
#   OP_GWS_ITEMS            comma-separated <account>=<1password-item> pairs
#   OP_GWS_ACCOUNT_NOTES    comma-separated <account>=<note> pairs for --accounts
#   OP_GWS_DEFAULT_ACCOUNT  account used when the first argument names no account
#   OP_GWS_VAULT            optional 1Password vault to scope item lookups
#   OP_GWS_ITEM             direct item override; skips account resolution entirely
#
# The item must hold client_id, client_secret, and refresh_token fields (see
# SKILL.md for the one-time onboarding of each account). op-gws caches the minted
# access_token and its expires_at back into the item so repeated calls within the
# token lifetime cost one op read and no network round-trip.

set -euo pipefail

: "${OP_GWS_ITEMS:=}"
: "${OP_GWS_ACCOUNT_NOTES:=}"
: "${OP_GWS_DEFAULT_ACCOUNT:=}"
: "${OP_GWS_VAULT:=}"
: "${OP_GWS_ITEM:=}"
: "${OP_GWS_TOKEN_ENDPOINT:=https://oauth2.googleapis.com/token}"

# Refresh when fewer than this many seconds of token lifetime remain.
EXPIRY_SKEW=300

for cmd in jq curl gws op; do
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

declare -A ACCOUNT_ITEMS=()
if [[ -n "$OP_GWS_ITEMS" ]]; then
    IFS=',' read -ra pairs <<< "$OP_GWS_ITEMS"
    for pair in "${pairs[@]}"; do
        [[ -z "$pair" ]] && continue
        name="${pair%%=*}"
        item="${pair#*=}"
        if [[ "$name" == "$pair" || -z "$name" || -z "$item" ]]; then
            echo "Error: malformed OP_GWS_ITEMS entry '$pair' (expected <account>=<item>)." >&2
            exit 3
        fi
        ACCOUNT_ITEMS["$name"]="$item"
    done
fi

# --accounts: emit the configured account names (with optional notes and the default
# marker) as JSON, so agents and skills can discover at runtime which accounts exist
# and what each is for. Names and notes only -- no item references, no op calls.
if [[ "${1:-}" == "--accounts" ]]; then
    declare -A ACCOUNT_NOTES=()
    if [[ -n "$OP_GWS_ACCOUNT_NOTES" ]]; then
        IFS=',' read -ra npairs <<< "$OP_GWS_ACCOUNT_NOTES"
        for pair in "${npairs[@]}"; do
            [[ -z "$pair" || "${pair%%=*}" == "$pair" ]] && continue
            ACCOUNT_NOTES["${pair%%=*}"]="${pair#*=}"
        done
    fi
    for name in "${!ACCOUNT_ITEMS[@]}"; do
        is_default=false
        if [[ "$name" == "$OP_GWS_DEFAULT_ACCOUNT" ]]; then
            is_default=true
        fi
        jq -n --arg account "$name" --arg note "${ACCOUNT_NOTES[$name]:-}" \
            --argjson default "$is_default" '{account: $account, note: $note, default: $default}'
    done | jq -cs 'sort_by(.account)'
    exit 0
fi

# Resolve which 1Password item to use. Precedence: OP_GWS_ITEM, then a leading
# account argument, then the default account.
ITEM="$OP_GWS_ITEM"
if [[ -z "$ITEM" ]]; then
    ACCOUNT=""
    if [[ $# -ge 1 && -n "${ACCOUNT_ITEMS[$1]+x}" ]]; then
        ACCOUNT="$1"
        shift
    elif [[ -n "$OP_GWS_DEFAULT_ACCOUNT" ]]; then
        ACCOUNT="$OP_GWS_DEFAULT_ACCOUNT"
    fi
    if [[ -n "$ACCOUNT" ]]; then
        ITEM="${ACCOUNT_ITEMS[$ACCOUNT]:-}"
        if [[ -z "$ITEM" ]]; then
            echo "Error: account '$ACCOUNT' is not configured in OP_GWS_ITEMS." >&2
            exit 3
        fi
    fi
fi

if [[ -z "$ITEM" ]]; then
    {
        echo "Error: no 1Password item resolved."
        echo "Usage: op-gws [<account>] <gws args...>"
        if [[ ${#ACCOUNT_ITEMS[@]} -gt 0 ]]; then
            echo "Configured accounts: ${!ACCOUNT_ITEMS[*]}"
        else
            echo "No accounts configured. Set OP_GWS_ITEM or OP_GWS_ITEMS."
        fi
    } >&2
    exit 3
fi

if [[ $# -lt 1 ]]; then
    echo "Usage: op-gws [<account>] <gws args...>" >&2
    exit 3
fi

VAULT_ARGS=()
if [[ -n "$OP_GWS_VAULT" ]]; then
    VAULT_ARGS=(--vault "$OP_GWS_VAULT")
fi

ITEM_JSON=$($OP_CMD item get "$ITEM" "${VAULT_ARGS[@]}" --format json)

# Fields are gws_-prefixed: the items are ordinary Google login items shared with a
# human password, and the prefix keeps the OAuth machinery visually separate.
field() {
    jq -r --arg l "$1" '[.fields[] | select(.label == $l) | .value // empty][0] // empty' <<< "$ITEM_JSON"
}

CLIENT_ID=$(field gws_client_id)
CLIENT_SECRET=$(field gws_client_secret)
REFRESH_TOKEN=$(field gws_refresh_token)
ACCESS_TOKEN=$(field gws_access_token)
EXPIRES_AT=$(field gws_expires_at)

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" || -z "$REFRESH_TOKEN" || "$REFRESH_TOKEN" == "REPLACE_ME" ]]; then
    echo "Error: item '$ITEM' must have gws_client_id, gws_client_secret, and gws_refresh_token fields." >&2
    echo "See the op-gws skill for the one-time onboarding steps (gws auth login/export)." >&2
    exit 2
fi

NOW=$(date +%s)
FRESH=false
if [[ -n "$ACCESS_TOKEN" && "$EXPIRES_AT" =~ ^[0-9]+$ ]] && (( EXPIRES_AT > NOW + EXPIRY_SKEW )); then
    FRESH=true
fi

if [[ "$FRESH" == false ]]; then
    echo "Minting a fresh Google access token for item '$ITEM'..." >&2
    RESPONSE=$(curl -sS "$OP_GWS_TOKEN_ENDPOINT" \
        --data-urlencode "grant_type=refresh_token" \
        --data-urlencode "client_id=$CLIENT_ID" \
        --data-urlencode "client_secret=$CLIENT_SECRET" \
        --data-urlencode "refresh_token=$REFRESH_TOKEN")

    ACCESS_TOKEN=$(jq -r '.access_token // empty' <<< "$RESPONSE")
    EXPIRES_IN=$(jq -r '.expires_in // empty' <<< "$RESPONSE")

    if [[ -z "$ACCESS_TOKEN" ]]; then
        # Never echo the raw response: extract only the error fields.
        ERR=$(jq -r '"\(.error // "unknown"): \(.error_description // "no description")"' <<< "$RESPONSE" 2> /dev/null \
            || echo "unparseable token endpoint response")
        echo "Error: token refresh failed for item '$ITEM': $ERR" >&2
        echo "If the refresh token was revoked, redo the onboarding for this account." >&2
        exit 2
    fi

    if ! [[ "$EXPIRES_IN" =~ ^[0-9]+$ ]]; then
        EXPIRES_IN=3600
    fi
    EXPIRES_AT=$((NOW + EXPIRES_IN))

    op item edit "$ITEM" "${VAULT_ARGS[@]}" \
        "gws_access_token[password]=$ACCESS_TOKEN" \
        "gws_expires_at[text]=$EXPIRES_AT" > /dev/null
fi

GOOGLE_WORKSPACE_CLI_TOKEN="$ACCESS_TOKEN" exec gws "$@"
