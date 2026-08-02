---
name: op-gws-onboard
description: Onboard (or re-onboard) one Google account for op-gws via a single browser login, harvesting OAuth credentials into 1Password without displaying them. Use when op-gws reports a missing or rejected refresh token.
---

# op-gws-onboard

One browser login per Google account; the resulting `client_id`/`client_secret`/
`refresh_token` go straight into a 1Password item as the `gws_`-prefixed fields that
`op-gws` consumes. Secrets travel via command substitution only — nothing is printed.

## When to use

- A new Google account should become usable through `op-gws`.
- `op-gws` fails with `invalid_grant` (refresh token expired or revoked) or reports a
  `REPLACE_ME`/missing `gws_refresh_token`.

The login is interactive (browser + account picker), so run it in the user's
terminal, not from an agent shell without a display.

## Usage

```bash
op-gws-onboard <1password-item> [gws auth login flags...]
```

Item names that are ambiguous (several items titled "Google") must be given as item
IDs. Extra flags go to `gws auth login`, e.g. `--readonly` or `-s drive,gmail`.

## What it does

1. Copies the OAuth client config (`~/.config/gws/client_secret.json`, override with
   `OP_GWS_ONBOARD_CLIENT_CONFIG`) into a throwaway gws config dir with a file
   keyring — the real gws state and OS keyring are untouched.
2. Runs `gws auth login` there (the manual browser step).
3. Harvests `gws auth export --unmasked` — without `--unmasked`, gws masks secrets
   (`GOCS...xyz`) and the item would be seeded with junk. A masked-looking or short
   refresh token is refused rather than stored.
4. Writes `gws_client_id` (text), `gws_client_secret` and `gws_refresh_token`
   (password) into the item with `op item edit`.

## Exit codes

- `1` — missing dependency
- `2` — credential problem (no client config, masked or missing export)
- `3` — usage error

## Prerequisites and pitfalls

- The OAuth client's consent screen should be published "In production": Testing
  status limits logins to registered test users and issues refresh tokens that
  expire after 7 days.
- Accounts that do not own the client's GCP project need the
  `roles/serviceusage.serviceUsageConsumer` role on it, or API calls fail with 403
  (gws sends `x-goog-user-project`).
- Re-running for an already-onboarded account is safe; it overwrites the fields.
