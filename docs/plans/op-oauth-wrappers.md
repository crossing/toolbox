# Plan: 1Password-backed OAuth for gws and freeagent

Status of the work on this branch and the setup that still has to happen outside the
repo. Implementation is done and `nix flake check` is green; the remaining steps are
account onboarding and home-ops wiring.

## Manual actions checklist

Everything a human still has to do, in order; details in the sections below.

- [ ] Decide the OAuth consent-screen audience: one Workspace org → Internal, one
      client; accounts across orgs → External with each account as a test user, or one
      client per org.
- [ ] Run `gws auth setup` (needs gcloud installed and logged in): project, Workspace
      APIs, consent screen, Desktop OAuth client. `--dry-run` previews.
- [ ] Create the 1Password items: one `gws-<account>` per Google account and one
      `FreeAgent`, each with `client_id`/`client_secret` (field layout below).
- [ ] Per Google account: `gws auth login` + `gws auth export` in a throwaway config
      dir, copy `refresh_token` into the item, delete the dir (commands below).
- [ ] FreeAgent: create the app at dev.freeagent.com, then run the one interactive
      `op-oauth2c` seed flow (command below).
- [ ] home-ops: install `op-gws`/`op-freeagent` from `overlays.default` with the
      `.override` item references (snippet below), plus `toolbox-skills`.
- [ ] Verify: `op-gws <account> drive files list --params '{"pageSize": 1}'` per
      account, and `op-freeagent bills list`.

## What this branch adds

- **`op-oauth2c --refresh`** — non-interactive renewal: reads the item's stored
  `refresh_token` and runs `oauth2c --grant-type refresh_token`, writing new tokens
  back. The SKILL.md now documents the working FreeAgent invocation (FreeAgent has no
  OIDC discovery, so `--authorization-endpoint`/`--token-endpoint` are required).
- **`op-gws`** — multi-account Google Workspace wrapper. Resolves a 1Password item per
  account, reuses the cached `access_token` while it has >5 min left, otherwise does a
  refresh-token grant against `https://oauth2.googleapis.com/token`, caches
  `access_token`/`expires_at` back into the item, and execs `gws` with
  `GOOGLE_WORKSPACE_CLI_TOKEN` set. That variable has highest auth priority in gws, so
  gws's on-disk credential store stays empty.
- **`op-freeagent`** — supplies `FREEAGENT_ACCESS_TOKEN` from the item; on a 401 it
  runs `op-oauth2c --refresh` and retries exactly once.

Configuration is baked in as environment-variable *defaults* (the environment always
wins), so consumers configure concrete 1Password item references with `.override`:

```nix
home.packages = with pkgs; [
  (op-gws.override {
    accounts = { work = "gws-work"; personal = "gws-personal"; };
    defaultAccount = "work";
    vault = "Private";
  })
  (op-freeagent.override { item = "FreeAgent"; })
];
```

Gotcha recorded in the Snowfall entrypoints: `callPackage` will happily satisfy an
argument named `vault` with nixpkgs' Vault package, so the config arguments are passed
explicitly there.

## 1Password items

One item per identity, API Credential category:

- `gws-<account>`: `client_id`, `client_secret`, `refresh_token`; the wrapper maintains
  `access_token` (concealed) and `expires_at` (unix seconds).
- `FreeAgent`: `client_id`, `client_secret`; `op-oauth2c` maintains `access_token` and
  `refresh_token`.

## One-time setup still to do

### Google (once per OAuth client)

`gws auth setup` drives gcloud end to end: project create/select, enabling the
Workspace APIs, and OAuth consent screen + Desktop client creation. Decision to make
first: if the Google accounts span different Workspace orgs, the consent screen must be
External (accounts added as test users) or one client per org; a single org can stay
Internal with one client.

### Per Google account

```bash
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=$(mktemp -d)
gws auth login          # browser flow; pick the account
gws auth export         # copy client_id, client_secret, refresh_token into gws-<account>
rm -rf "$GOOGLE_WORKSPACE_CLI_CONFIG_DIR"; unset GOOGLE_WORKSPACE_CLI_CONFIG_DIR
```

The initial grant must go through `gws auth login`, not oauth2c: oauth2c cannot send
`access_type=offline`, so it never receives a Google refresh token.

### FreeAgent (once)

Create an app at dev.freeagent.com, put `client_id`/`client_secret` in the item, then
seed tokens with one interactive flow:

```bash
op-oauth2c "FreeAgent" https://api.freeagent.com \
  --grant-type authorization_code \
  --authorization-endpoint https://api.freeagent.com/v2/approve_app \
  --token-endpoint https://api.freeagent.com/v2/token_endpoint \
  --auth-method client_secret_basic
```

### home-ops

Consume `op-gws` and `op-freeagent` from `overlays.default` (both are exported flat)
and apply the `.override` configuration above. The SKILL.mds ship in `toolbox-skills`
already; agents are told to use the wrappers and never bare `gws`/`freeagent`.
