---
name: op-oauth2c
description: Run an OAuth2 flow using client credentials stored in 1Password, writing the resulting tokens back to the same item. Use when a tool needs a fresh access token.
---

# op-oauth2c

Performs an OAuth2 flow without any token touching disk. Credentials come out of a
1Password item and the resulting tokens go straight back into it.

## Usage

```bash
op-oauth2c <1password-item> <oauth-issuer-url> [extra oauth2c flags]            # interactive
op-oauth2c --refresh <1password-item> <oauth-issuer-url> [extra oauth2c flags]  # non-interactive
```

`--refresh` exchanges the item's stored `refresh_token` for a new access token without a
browser. Use it whenever a stored access token has expired; fall back to the interactive
flow only when there is no refresh token yet (first run) or the refresh grant is
rejected.

FreeAgent example (FreeAgent has no OIDC discovery document, so the endpoints must be
given explicitly):

```bash
# First run — browser flow, seeds access_token + refresh_token in the item:
op-oauth2c "FreeAgent" https://api.freeagent.com \
  --grant-type authorization_code \
  --response-types code --response-mode query \
  --authorization-endpoint https://api.freeagent.com/v2/approve_app \
  --token-endpoint https://api.freeagent.com/v2/token_endpoint \
  --auth-method client_secret_basic

# Every renewal after that — no browser:
op-oauth2c --refresh "FreeAgent" https://api.freeagent.com \
  --token-endpoint https://api.freeagent.com/v2/token_endpoint \
  --auth-method client_secret_basic
```

## What it does

1. Reads `client_id` and `client_secret` from the named 1Password item (and, with
   `--refresh`, the stored `refresh_token`).
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
