---
name: op-freeagent
description: Run the freeagent CLI with credentials from 1Password, auto-refreshing expired tokens. Use instead of bare freeagent, which needs FREEAGENT_ACCESS_TOKEN set manually; when the op-mcp service is running, prefer its freeagent MCP tool for reads.
---

# op-freeagent

Wrapper around the `freeagent` CLI that supplies `FREEAGENT_ACCESS_TOKEN` from a
1Password item and transparently refreshes it (via `op-oauth2c --refresh`) when
FreeAgent answers 401. Tokens never touch disk.

## Prefer op-mcp for reads

When the op-mcp MCP tools are available in your session, use its `freeagent`
tool for read operations (`<resource> list|get`) instead of this CLI: the
running service holds tokens in memory, so reads need no 1Password
authorization. This CLI is the fallback when the service is not running — each
invocation then needs the desktop-app authorization. Writes differ by path:
through op-mcp they become plans a human reviews and runs; through this CLI
they execute directly. See the op-mcp skill.

## Usage

```bash
op-freeagent <freeagent args...>
```

Same arguments as `freeagent` — see the `freeagent` skill for the command reference:

```bash
op-freeagent bills list --human
op-freeagent transactions list --bank-account https://api.freeagent.com/v2/bank_accounts/123
```

Do not call bare `freeagent` — it has no token configured.

## Configuration

The 1Password item is baked in at build time (`op-freeagent.withConfig { item = "..."; }`
in home-ops) and can be overridden via environment:

- `OP_FREEAGENT_ITEM` — 1Password item holding `client_id`, `client_secret`,
  `access_token`, `refresh_token`
- `OP_FREEAGENT_ISSUER` / `OP_FREEAGENT_TOKEN_ENDPOINT` — override for the FreeAgent
  sandbox (`https://api.sandbox.freeagent.com/...`)

## Behaviour

1. Reads `access_token` from the item (via `safe-op` when available). If absent,
   refreshes first.
2. Runs `freeagent` with the token. stdout streams through untouched; stderr is
   buffered to detect auth failures, then replayed.
3. On exit ≠ 0 with `status 401` on stderr: runs `op-oauth2c --refresh`, re-reads the
   token, retries exactly once.

## Exit codes

- `1` — missing dependency
- `3` — usage/configuration error (no item configured, no arguments)
- otherwise, whatever `freeagent` exits with

## One-time onboarding

The item needs `client_id`/`client_secret` from a dev.freeagent.com app, then one
interactive flow seeds the tokens:

```bash
op-oauth2c "FreeAgent" https://api.freeagent.com \
  --grant-type authorization_code \
  --response-types code --response-mode query \
  --authorization-endpoint https://api.freeagent.com/v2/approve_app \
  --token-endpoint https://api.freeagent.com/v2/token_endpoint \
  --auth-method client_secret_basic
```

After that every renewal is non-interactive; FreeAgent refresh tokens do not expire.
