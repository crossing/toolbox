---
name: op-gws
description: Run gws (Google Workspace CLI) with credentials from 1Password, supporting multiple Google accounts. Use instead of bare gws whenever Workspace data is needed; prefer the MCP gateway's gmail_*/drive_* tools first, and reach for this CLI for everything the gateway does not carry.
---

# op-gws

Wrapper around `gws` that mints a Google access token from a 1Password item and execs
`gws` with `GOOGLE_WORKSPACE_CLI_TOKEN` set. One item per Google account; tokens never
touch disk, and `gws`'s own on-disk credential store stays empty.

## Prefer the MCP gateway

The hosted MCP gateway (connector "Gateway", `https://mcp.xing.works/mcp`) is the
first choice for Google Workspace work. Its `gmail_*` and `drive_*` tools hold
their own upstream tokens, so they cost no 1Password authorization at all, and
reads and writes both execute directly — destructive tools take `confirm: true`
and every write lands in the gateway's audit log. Each tool takes an optional
`account`; `gateway_list_accounts` names the linked accounts and the per-service
default.

This CLI is the fallback for what the gateway does not carry:

- Services with no gateway tools at all: `calendar`, `docs`, `sheets`, `slides`,
  `keep`, `tasks`, `people`, `chat`, `forms`, `meet`, `admin-reports`.
- Gmail beyond the gateway's catalogue: sending (the gateway only drafts),
  trashing or deleting messages, thread-level modification, settings (send-as,
  forwarding, vacation), and `history`/`watch`.
- Drive permissions and sharing, revisions, and copy.
- Raw API access — `gws schema`, `--page-all`, parameters no tool exposes.

Both paths reach the same mailboxes; the gateway's Google link and this CLI's
1Password items are separate credentials for the same accounts.

## Log the gaps you hit

When a task drops to this CLI because the gateway has no tool for it, record it —
that list is what drives gateway parity work. Read `bd show work-ysf` first and
only file a new child if the gap is not already one of its children:

```bash
bd create "gateway: <what is missing>" --parent work-ysf -p 2 -l gateway,mcp \
  -d "<the task, and the CLI command used instead>"
```

Never stop a task to file one: run the CLI, finish the work, then log it.

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

## Discovering accounts

```bash
op-gws --accounts
# [{"account":"personal","note":"home stuff","default":false},
#  {"account":"work","note":"org account","default":true}]
```

This is the canonical way for an agent (or another skill) to learn which Google
accounts are available and what each is for: names, free-text notes, and the default
marker — never item references or secrets. When a task names a person, mailbox, or
domain, pick the matching account from this list; otherwise the default applies.

## Configuration

Account-to-item mappings are baked in at build time (`op-gws.withConfig { accounts = ...; }`
in home-ops) and can be overridden via environment:

- `OP_GWS_ITEMS` — comma-separated `<account>=<1password-item>` pairs
- `OP_GWS_DEFAULT_ACCOUNT` — account used when no account argument is given
- `OP_GWS_VAULT` — optional vault scoping item lookups
- `OP_GWS_ITEM` — direct item override; skips account resolution (all args go to gws)

## Token handling

Fields are `gws_`-prefixed so the items can be ordinary Google login items shared with
a human password.

1. Reads `gws_client_id`, `gws_client_secret`, `gws_refresh_token`, and any cached
   `gws_access_token`/`gws_expires_at` from the item (via `safe-op` when available).
2. If the cached token has more than 5 minutes left, uses it — one op read, no network.
3. Otherwise does a refresh-token grant against `https://oauth2.googleapis.com/token`
   and writes the new `gws_access_token` (password field) and `gws_expires_at` (unix
   seconds) back into the item.

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
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file
gws auth login          # browser flow; pick the account
# Harvest without displaying: capture `gws auth export --unmasked` with command
# substitution and write gws_client_id (text), gws_client_secret and
# gws_refresh_token (password) into the 1Password item with `op item edit`.
# Without --unmasked, gws masks the secrets ("GOCS...xyz") and you store junk.
rm -rf "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR"; unset GOOGLE_WORKSPACE_CLI_CONFIG_DIR
```

The refresh token does not expire in normal use; re-onboard only if it is revoked
(password change, admin action, or 6 months unused for some account types).

## Limits

- The item lookup passes the reference verbatim to `op item get`; account names and
  item names must not contain `,` or `=`.
- Client secret and refresh token appear transiently in the curl argument list on this
  machine (same exposure as op-oauth2c passing them to oauth2c).
