---
name: op-gws
description: Run gws (Google Workspace CLI) with credentials from 1Password, supporting multiple Google accounts. Use instead of bare gws whenever Workspace data is needed.
---

# op-gws

Wrapper around `gws` that mints a Google access token from a 1Password item and execs
`gws` with `GOOGLE_WORKSPACE_CLI_TOKEN` set. One item per Google account; tokens never
touch disk, and `gws`'s own on-disk credential store stays empty.

## Usage

```bash
op-gws [<account>] <gws args...>
```

If the first argument matches a configured account name it selects that account and is
consumed; otherwise the default account is used and all arguments go to `gws`:

```bash
op-gws work gmail users messages list --params '{"userId": "me"}'
op-gws drive files list --params '{"pageSize": 10}'   # default account
```

Do not call bare `gws` for data access — it has no credentials configured.

## Configuration

Account-to-item mappings are baked in at build time (`op-gws.override { accounts = ...; }`
in home-ops) and can be overridden via environment:

- `OP_GWS_ITEMS` — comma-separated `<account>=<1password-item>` pairs
- `OP_GWS_DEFAULT_ACCOUNT` — account used when no account argument is given
- `OP_GWS_VAULT` — optional vault scoping item lookups
- `OP_GWS_ITEM` — direct item override; skips account resolution (all args go to gws)

## Token handling

1. Reads `client_id`, `client_secret`, `refresh_token`, and any cached
   `access_token`/`expires_at` from the item (via `safe-op` when available).
2. If the cached token has more than 5 minutes left, uses it — one op read, no network.
3. Otherwise does a refresh-token grant against `https://oauth2.googleapis.com/token`
   and writes the new `access_token` (password field) and `expires_at` (unix seconds)
   back into the item.

## Exit codes

- `1` — missing dependency
- `2` — credential problem (incomplete item, refresh rejected)
- `3` — usage/configuration error (unknown account, no item resolved)
- otherwise, whatever `gws` exits with

## One-time onboarding of an account

Requires a Desktop-type OAuth client in a GCP project with the Workspace APIs enabled
(`gws auth setup` automates project/API/consent/client creation via gcloud). Then:

```bash
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=$(mktemp -d)
gws auth login          # browser flow; pick the account
gws auth export         # prints client id/secret + refresh token
# Copy client_id, client_secret, refresh_token into the 1Password item, then:
rm -rf "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR"; unset GOOGLE_WORKSPACE_CLI_CONFIG_DIR
```

The refresh token does not expire in normal use; re-onboard only if it is revoked
(password change, admin action, or 6 months unused for some account types).

## Limits

- The item lookup passes the reference verbatim to `op item get`; account names and
  item names must not contain `,` or `=`.
- Client secret and refresh token appear transiently in the curl argument list on this
  machine (same exposure as op-oauth2c passing them to oauth2c).
