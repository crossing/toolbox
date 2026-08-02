#!/usr/bin/env bash

# op-gws-onboard: one browser login per Google account; harvests the resulting OAuth
# credentials straight into a 1Password item without displaying them.
#
# Usage: op-gws-onboard <1password-item> [gws auth login flags...]
#
# The item receives gws_client_id / gws_client_secret / gws_refresh_token -- the
# layout op-gws consumes. The OAuth client config is reused from an existing gws
# setup (~/.config/gws/client_secret.json by default). The login runs in a throwaway
# config dir with a file keyring, so the real gws state and OS keyring are untouched.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    {
        echo "Usage: op-gws-onboard <1password-item> [gws auth login flags...]"
        echo ""
        echo "Opens a browser login for one Google account and stores the harvested"
        echo "credentials in the named 1Password item as gws_-prefixed fields."
    } >&2
    exit 3
fi

ITEM="$1"
shift

for cmd in gws jq op; do
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: Required command '$cmd' not found." >&2
        exit 1
    fi
done

CLIENT_CONFIG="${OP_GWS_ONBOARD_CLIENT_CONFIG:-$HOME/.config/gws/client_secret.json}"
if [[ ! -f "$CLIENT_CONFIG" ]]; then
    echo "Error: no OAuth client config at $CLIENT_CONFIG." >&2
    echo "Run 'gws auth setup' once (or set OP_GWS_ONBOARD_CLIENT_CONFIG)." >&2
    exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cp "$CLIENT_CONFIG" "$TMP/client_secret.json"

export GOOGLE_WORKSPACE_CLI_CONFIG_DIR="$TMP"
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file

echo ">>> Browser will open: pick the Google account that belongs to item '$ITEM'." >&2
gws auth login "$@"

# --unmasked matters: without it gws masks the secrets ("GOCS...xyz") and the item
# would be seeded with junk that Google rejects as invalid_client.
EXPORT=$(gws auth export --unmasked)
CID=$(jq -r '.client_id // empty' <<< "$EXPORT")
CSEC=$(jq -r '.client_secret // empty' <<< "$EXPORT")
RT=$(jq -r '.refresh_token // empty' <<< "$EXPORT")

if [[ -z "$RT" ]]; then
    echo "Error: no refresh token in gws export; nothing stored." >&2
    exit 2
fi
# Guard against masked output: a real Google refresh token is ~100 chars and never
# contains an ellipsis.
if [[ "${#RT}" -lt 50 || "$RT" == *"..."* ]]; then
    echo "Error: gws export looks masked (token too short or elided); nothing stored." >&2
    exit 2
fi

op item edit "$ITEM" \
    "gws_client_id[text]=$CID" \
    "gws_client_secret[password]=$CSEC" \
    "gws_refresh_token[password]=$RT" > /dev/null

echo "Stored gws credentials in 1Password item '$ITEM'. No secret was displayed." >&2
