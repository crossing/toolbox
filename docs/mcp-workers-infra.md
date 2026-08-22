# mcp-workers: infrastructure inventory and teardown

Everything the hosted-MCP stack created outside this repo, so it can be
audited, rotated, or deleted without archaeology. Design lives in
[plans/mcp-gateway.md](plans/mcp-gateway.md); operational state in
[plans/mcp-workers-handoff.md](plans/mcp-workers-handoff.md). This file
answers one question: **what exists, and what do I delete to make it all
go away?**

Written 2026-08-22. Several resources here were created by hand through web
consoles — those are the ones a teardown forgets, so they are called out
explicitly below.

**This repo is public.** Account identifiers (Cloudflare account/zone IDs,
Google project, the FreeAgent company subdomain, email addresses, OAuth
client IDs) are deliberately absent. Every entry says *where* to look the
value up instead: a 1Password reference, a console, or a command. The
private rollout notes hold the specifics.

## Not part of this stack

The Cloudflare account also hosts `fathom-learning` and
`fathom-learning-mcp` (with `fathom.xing.works` / `fathom-mcp.xing.works`).
They pre-date this work and are unrelated — **do not delete them** while
tearing down mcp-workers.

## Cloudflare

Account and zone IDs: `npx wrangler whoami`, or the dashboard URL. All
commands below need `CLOUDFLARE_API_TOKEN` (see *Credentials*).

### Workers (3)

| Worker | Custom domain | Purpose | Retire when |
|---|---|---|---|
| `gateway-mcp` | `mcp.xing.works` | The gateway — the only connector claude.ai needs | Tearing down the whole stack |
| `gws-mcp` | `gws-mcp.xing.works` | Pre-gateway Gmail/Drive worker | Superseded by gateway G1; retire after probation |
| `freeagent-mcp` | `freeagent-mcp.xing.works` | Pre-gateway FreeAgent worker | Superseded by gateway G2/G3; retire after probation |

Deleting a Worker also deletes its Durable Object namespaces and their
SQLite contents, and detaches its custom domain. It does **not** delete KV
namespaces or the upstream OAuth apps.

```
npx wrangler delete -c tools/mcp-workers/<worker>/wrangler.jsonc --name <worker>
```

### KV namespaces (3)

One per worker, holding `workers-oauth-provider` grants (client
registrations, auth codes, refresh tokens for the *downstream* MCP clients).
IDs are committed in each `wrangler.jsonc`; titles are `gateway-mcp-oauth`,
`gws-mcp-oauth`, `freeagent-mcp-oauth`.

Deleting one invalidates every connector grant for that worker — clients
simply reconnect. They are **not** removed with the Worker; delete
explicitly:

```
npx wrangler kv namespace list          # confirm ids/titles
npx wrangler kv namespace delete --namespace-id <id>
```

### Durable Object namespaces (4)

`gateway-mcp_GatewayMCP` (per-session MCP agent), **`gateway-mcp_UserVault`**
(per-identity vault: service toggles, linked-account refresh tokens as
AES-GCM ciphertext, audit log), `gws-mcp_GwsMCP`, `freeagent-mcp_FreeagentMCP`.
All SQLite-backed, all removed when their Worker is deleted.

`UserVault` is the only place linked upstream tokens live. Deleting
`gateway-mcp` destroys them — accounts must be re-linked on `/manage`
afterwards. It does not revoke them upstream (see *Upstream OAuth apps*).

```
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  https://api.cloudflare.com/client/v4/accounts/<account>/workers/durable_objects/namespaces
```

### Custom domains (3, hand-attached)

`mcp.xing.works`, `gws-mcp.xing.works`, `freeagent-mcp.xing.works` on the
`xing.works` zone, attached once via the Workers Domains API (not via
wrangler routes — the deploy token deliberately has no zone permissions).
Deleting the Worker detaches the domain; the DNS record is managed by
Cloudflare and disappears with it.

```
GET    /accounts/<account>/workers/domains        # list, find the id
DELETE /accounts/<account>/workers/domains/<id>   # only if orphaned
```

### Worker secrets

Pushed by `tools/mcp-workers/scripts/op-cf-secrets.sh <worker>` from
[`secrets.manifest.json`](../tools/mcp-workers/secrets.manifest.json); they
live only inside the Worker and die with it. Current names:

- `gateway-mcp`: `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`, `ALLOWED_EMAILS`,
  `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`, `ALLOWED_COMPANY`,
  `VAULT_KEY`, `COOKIE_SECRET`
- `gws-mcp`: `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`, `ALLOWED_EMAILS`
- `freeagent-mcp`: `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`,
  `ALLOWED_COMPANY`

`VAULT_KEY` is the AES-GCM key for vault ciphertext and exists **only** in
the Worker and 1Password. Lose both and every linked account must be
re-linked; the vault rows become undecryptable.

## Upstream OAuth apps (hand-created, easy to forget)

Neither is removed by deleting Workers. Both are dedicated to the hosted
path — revoking them does not affect the local CLIs, which use separate
credentials on the same 1Password items.

**Google Web OAuth client, named `gws-mcp`** — in the Google Cloud console
(APIs & Services → Credentials) of the personal-account project. Redirect
URIs currently list both `https://gws-mcp.xing.works/callback` and
`https://mcp.xing.works/callback`; drop the gws one when that worker
retires. Console access needs `authuser=<the project-owner account>` in the
URL — the other account gets "You need additional access". Credentials live
in 1Password (see below). Deleting this client breaks both the gateway's
identity sign-in and its Google account linking.

**FreeAgent app, named `freeagent-mcp`** — at dev.freeagent.com/apps
(separate from the older CLI app, so revocation is independent). Redirect
URIs list both `https://freeagent-mcp.xing.works/callback` and
`https://mcp.xing.works/callback`. FreeAgent has no token-revocation
endpoint, so unlinking in `/manage` only drops the stored token: to truly
revoke, use FreeAgent → Settings → Approved Applications, or destroy the app
here.

Granted user consents also survive Worker deletion:

- Google: myaccount.google.com → Data & privacy → Third-party apps.
- FreeAgent: Settings → Approved Applications.

## 1Password

All under the Private vault. **The `mcp_*` fields were added by this work;
the sibling fields on the same items belong to the local CLIs and
op-oauth wrappers — deleting those breaks the CLIs.**

| Item | Fields to delete on teardown | Leave alone |
|---|---|---|
| `mcp-gateway` (secure note, created for this) | the whole item: `vault_key`, `cookie_secret` | — |
| `Google` (login) | `mcp_client_id`, `mcp_client_secret`, `mcp_allowed_emails` | `gws_client_id`, `gws_client_secret`, `gws_refresh_token`, `gws_access_token`, `gws_expires_at`, and the login itself |
| `FreeAgent` (login) | `mcp_client_id`, `mcp_client_secret`, `mcp_allowed_company` | `client_id`, `client_secret`, `access_token`, `refresh_token`, and the login itself |
| `cloudflare.com` (login) | `api_token_wrangler-mcp-workers` | the login, OTP, other tokens |

Item references are in
[`secrets.manifest.json`](../tools/mcp-workers/secrets.manifest.json) as
`op://` paths. To inspect fields without exposing values (run from the
persistent op shell, per the repo's 1Password rule):

```
op item get <item> --vault Private --format json \
  | python3 -c 'import json,sys; [print(f["label"], f["type"], len(f.get("value") or "")) for f in json.load(sys.stdin)["fields"]]'
```

## Credentials

**Deploy token** — a user API token named `wrangler-mcp-workers`, stored as
the `api_token_wrangler-mcp-workers` field on the `cloudflare.com` item.
Scoped to Workers Scripts/KV/Secrets Store/R2 write, tail + observability
read, account settings read, user details read. Deliberately **no zone
permissions** (hence the Workers Domains API for custom domains).

Tokens can only be listed, rolled, or deleted from
dash.cloudflare.com/profile/api-tokens — the API refuses token endpoints
when authenticating with an account-scoped token. A dead duplicate token of
the same name exists from a mistaken first creation; delete it there too.

## claude.ai connectors

Custom connectors are per-account UI state, invisible to any API here.
Disconnect and remove them in claude.ai → Settings → Connectors:
**Gateway** (`https://mcp.xing.works/mcp`) and, if still present, the older
**GWS** and **FreeAgent** connectors.

Note: claude.ai caches a connector's tool list. After changing the server's
catalog, use the connector's ⋯ menu → **Refresh tools list**; newly appearing
tools do not inherit a group's "Always allow" and prompt once each.

## Local and repo artifacts

- Worktree `~/works/home/toolbox-wt-mcp-workers` (see `git worktree list`).
- `tools/mcp-workers/*/.wrangler/` — local build/state caches, gitignored.
  Safe to delete; regenerated by `wrangler dev`.
- `tools/mcp-workers/node_modules/` — reinstall with `npm install`.
- Nothing in the local CLI/op-mcp/WhatsApp stack is touched by this work.

## Teardown order

Reverse of creation, so nothing is orphaned:

1. **claude.ai** — disconnect and remove the custom connectors (otherwise
   they linger, failing).
2. **Upstream consents** — revoke in the Google account and in FreeAgent's
   Approved Applications, so no live grant outlives the infrastructure.
3. **Workers** — `wrangler delete` each of the three. Takes the Durable
   Objects (including the vault and its encrypted tokens) and detaches the
   custom domains.
4. **KV namespaces** — delete all three explicitly; they survive step 3.
5. **Custom domains** — verify none are orphaned; delete any that are.
6. **Upstream OAuth apps** — delete the `gws-mcp` Google client and the
   `freeagent-mcp` FreeAgent app.
7. **Cloudflare API tokens** — delete `wrangler-mcp-workers` (and its dead
   duplicate) in the dashboard.
8. **1Password** — delete the `mcp-gateway` item and only the `mcp_*` fields
   listed above. Leave the CLI fields alone.

Partial teardown (retiring just `gws-mcp` and `freeagent-mcp` once the
gateway has proven itself) is steps 1, 3, 4 for those two workers, plus
trimming their redirect URIs from the upstream OAuth apps in step 6 —
leaving the apps themselves in place, since the gateway still uses them.
