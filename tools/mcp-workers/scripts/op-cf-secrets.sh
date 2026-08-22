#!/usr/bin/env bash
# op-cf-secrets — sync Worker secrets from 1Password to Cloudflare.
#
# 1Password is the source of truth; secrets.manifest.json (next to this
# script's parent directory) maps env var names to op:// references per
# worker. Values are resolved with `op read` and piped straight into
# `wrangler secret bulk` — they never touch argv (world-readable via
# /proc/*/cmdline), the terminal, or disk. Rotation = edit the field in
# 1Password, re-run this script.
#
# Current backend: classic per-worker secrets. Nothing is shared across
# workers yet; when gws-mcp lands and shares e.g. ALLOWED_EMAILS, the
# account-level Secrets Store (beta) slots in behind the same manifest.
#
# Run from a persistent op shell (tmux "opshell") with:
#   CLOUDFLARE_API_TOKEN=$(op read "op://Private/cloudflare.com/api_token_wrangler-mcp-workers") \
#     ./scripts/op-cf-secrets.sh <worker>

set -euo pipefail

usage() {
  echo "usage: op-cf-secrets.sh <worker> [--dry-run]" >&2
  echo "workers defined in secrets.manifest.json" >&2
  exit 2
}

[ $# -ge 1 ] || usage
worker=$1
dry_run=${2:-}

root=$(cd "$(dirname "$0")/.." && pwd)
manifest=$root/secrets.manifest.json

config=$(jq -re --arg w "$worker" '.[$w].config' "$manifest") || {
  echo "error: worker '$worker' not in $manifest" >&2
  exit 1
}

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ "$dry_run" != "--dry-run" ]; then
  echo "error: CLOUDFLARE_API_TOKEN not set (read it from 1Password in the op shell)" >&2
  exit 1
fi

# Resolve each op:// reference into an exported env var, then let jq assemble
# the JSON from its own environment (envs are owner-readable only, unlike argv).
names=$(jq -r --arg w "$worker" '.[$w].secrets | keys[]' "$manifest")
for name in $names; do
  ref=$(jq -re --arg w "$worker" --arg n "$name" '.[$w].secrets[$n]' "$manifest")
  value=$(op read "$ref")
  [ -n "$value" ] || { echo "error: empty value for $name ($ref)" >&2; exit 1; }
  export "OPCF_$name"="$value"
  echo "resolved $name from $ref"
done

if [ "$dry_run" = "--dry-run" ]; then
  echo "dry run: would push to $config: $names" | tr '\n' ' '
  echo
  exit 0
fi

jq -n --arg w "$worker" --slurpfile m "$manifest" \
  '$m[0][$w].secrets | with_entries(.value = env["OPCF_" + .key])' \
  | (cd "$root" && npx wrangler secret bulk -c "$config")
