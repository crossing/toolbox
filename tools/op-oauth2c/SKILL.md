---
name: op-oauth2c
description: Run an OAuth2 flow using client credentials stored in 1Password, writing the resulting tokens back to the same item. Use when a tool needs a fresh access token.
---

# op-oauth2c

Performs an OAuth2 flow without any token touching disk. Credentials come out of a
1Password item and the resulting tokens go straight back into it.

## Usage

```bash
op-oauth2c <1password-item> <oauth-issuer-url> [extra oauth2c flags]
```

Example:

```bash
op-oauth2c "FreeAgent Dev" https://api.freeagent.com
```

## What it does

1. Reads `client_id` and `client_secret` from the named 1Password item.
2. Runs the `oauth2c` flow against the issuer.
3. Writes `access_token` (text field) and `refresh_token` (password field) back to that
   same item.

Progress messages go to stderr, so stdout stays clean for piping.

## Prerequisites

- The 1Password item must already have `client_id` and `client_secret` fields.
- You must be signed in to `op`.
- `safe-op` is used to read the credentials when it is on PATH, falling back to `op`.

## Notes

- Tokens are never written to a file or printed to the terminal.
- Re-running overwrites the stored tokens; that is the intended refresh path.
- The item name is passed to `op` verbatim, so quote names containing spaces.
