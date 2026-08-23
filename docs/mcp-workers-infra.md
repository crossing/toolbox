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

### Workers (4)

| Worker | Custom domain | Purpose | Retire when |
|---|---|---|---|
| `gateway-mcp` | `mcp.xing.works` | The gateway — the only connector claude.ai needs | Tearing down the whole stack |
| `whatsapp-bridge` | none, by design | Hosts the WhatsApp bridge Durable Object; reached only over the gateway's cross-script binding | Tearing down the whole stack, or abandoning G4 |
| `gws-mcp` | `gws-mcp.xing.works` | Pre-gateway Gmail/Drive worker | Superseded by gateway G1; retire after probation |
| `freeagent-mcp` | `freeagent-mcp.xing.works` | Pre-gateway FreeAgent worker | Superseded by gateway G2/G3; retire after probation |

`whatsapp-bridge` is **not** `tools/whatsapp-bridge`, the local Go bridge it
mirrors. Deleting the Worker destroys the cloud WhatsApp session and its stored
messages; the local stack is untouched by anything here. Delete the Worker
before or after the gateway — the gateway simply reports the bridge as
unreachable in the meantime.

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

### Durable Object namespaces (5)

`gateway-mcp_GatewayMCP` (per-session MCP agent), **`gateway-mcp_UserVault`**
(per-identity vault: service toggles, linked-account refresh tokens as
AES-GCM ciphertext, audit log), **`whatsapp-bridge_WhatsAppBridge`** (the
WhatsApp session: Signal keys, chats and messages), `gws-mcp_GwsMCP`,
`freeagent-mcp_FreeagentMCP`. All SQLite-backed, all removed when their Worker
is deleted.

`whatsapp-bridge_WhatsAppBridge` holds **Signal session keys and message
history**. Deleting it means re-pairing the device (and removing the orphaned
entry from the phone's linked-devices list) and re-importing history.

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
- `whatsapp-bridge`: none. It has no upstream OAuth and no HTTP surface; the
  WhatsApp session lives in its Durable Object and nowhere else.

`VAULT_KEY` is the AES-GCM key for vault ciphertext and exists **only** in
the Worker and 1Password. Lose both and every linked account must be
re-linked; the vault rows become undecryptable.

## Google

Everything here lives in one personal-account Google Cloud project (the
project id is in the private notes). **Console access needs
`authuser=<the project-owner account>` in the URL** — the other allowlisted
account gets "You need additional access" and it looks like a permissions
bug. Nothing on this side is removed by deleting Workers.

### OAuth clients — two, only one is ours

APIs & Services → Credentials lists both. **Check the type before
deleting.**

| Name | Type | Created | Owner |
|---|---|---|---|
| `gws-mcp` | Web application | 2026-08-21 | **This work** — delete on teardown |
| `GWS` | Desktop | 2026-04-18 | The `gws` CLI / op-oauth wrappers — **leave alone** |

The Desktop client is why a new one was needed at all: Google refuses
`https://` redirect URIs on Desktop clients, so a hosted Worker cannot use
it. The project has no API keys and no service accounts.

`gws-mcp` redirect URIs currently list **both**
`https://gws-mcp.xing.works/callback` and `https://mcp.xing.works/callback`;
drop the first when `gws-mcp` retires. Its id/secret are the `mcp_client_id`
/ `mcp_client_secret` fields in 1Password. Deleting this client breaks the
gateway's identity sign-in *and* its Google account linking — it is the
single Google credential the gateway has.

### Consent screen (Google Auth Platform)

- **Publishing status: In production; user type: External.** This matters
  operationally: in *Testing* mode Google expires refresh tokens after 7
  days, which would break linked accounts weekly. Do not click "Back to
  testing".
- **OAuth user cap: 2 of 100 used.** The cap counts distinct accounts that
  have ever granted consent, applies for the **lifetime of the project, and
  cannot be reset**. Re-linking an account already counted does not consume
  another slot; onboarding a new account does.
- **Data Access lists no scopes.** Scopes are requested per authorization at
  runtime, so the source of truth is
  [`gateway/src/google.ts`](../tools/mcp-workers/gateway/src/google.ts)
  (identity: `openid email`; link: readonly, or the write set), not the
  console. Because those sensitive scopes were never submitted for
  verification, every link shows the **"Google hasn't verified this app"**
  interstitial — Advanced → "Go to xing.works (unsafe)" is the expected path,
  not a misconfiguration.
- The app's display name is **xing.works**, which is what the consent screen
  says and what to look for when revoking per-account.
- Never add the `cloud-platform` scope: Workspace accounts then die on Google
  Cloud session reauth (`invalid_rapt`).

### Per-account consent

Each linked account holds its own grant, and grants outlive the
infrastructure. Revoke at myaccount.google.com → Data & privacy →
Third-party apps & services ("Linked apps"), entry **xing.works** — once per
allowlisted account, signed in as that account.

## FreeAgent

### Apps — two, only one is ours

dev.freeagent.com/apps lists both. **Check the creation date before
deleting.**

| Name | Created | Owner |
|---|---|---|
| `freeagent-mcp` | 2026-08-21 | **This work** — delete on teardown |
| `Freeagent CLI` | 2013-05-05 | The `freeagent` CLI — **leave alone** |

Separate apps were the point: revoking the hosted path cannot disturb the
CLI. `freeagent-mcp`'s redirect URIs list both
`https://freeagent-mcp.xing.works/callback` and
`https://mcp.xing.works/callback`; drop the first when `freeagent-mcp`
retires. Its OAuth identifier and secret are the `mcp_client_id` /
`mcp_client_secret` fields in 1Password.

The app page also manages secrets directly — "Generate new secret" adds one
and each row has its own **Revoke**. Rolling a secret there means
re-running `op-cf-secrets.sh` for both `gateway` and `freeagent` after
pasting the new value into 1Password.

### Per-company approval

FreeAgent has **no token-revocation endpoint**, so unlinking on `/manage`
only drops the stored token — the upstream grant stays live. To actually
revoke: FreeAgent → Settings → Approved Applications (as the authorizing
user), or destroy the app in the developer dashboard.

Only one company can ever be linked: the callback compares the subdomain
from `GET /v2/company` against `ALLOWED_COMPANY` and refuses anything else,
which is why the FreeAgent tools carry no `account` parameter.

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
2. **Upstream consents** — revoke per account, so no live grant outlives the
   infrastructure: **xing.works** in each allowlisted Google account's Linked
   apps (signed in as that account), and FreeAgent → Settings → Approved
   Applications. FreeAgent's has no API equivalent; it is this click or
   nothing.
3. **Workers** — `wrangler delete` each of the three. Takes the Durable
   Objects (including the vault and its encrypted tokens) and detaches the
   custom domains.
4. **KV namespaces** — delete all three explicitly; they survive step 3.
5. **Custom domains** — verify none are orphaned; delete any that are.
6. **Upstream OAuth apps** — delete the **Web** client `gws-mcp` (not the
   Desktop `GWS`) and the FreeAgent app `freeagent-mcp` (not `Freeagent
   CLI`). Deleting either sibling breaks the local CLIs. The Google project
   itself can stay: its consent screen and lifetime user cap are shared with
   the CLI client.
7. **Cloudflare API tokens** — delete `wrangler-mcp-workers` (and its dead
   duplicate) in the dashboard.
8. **1Password** — delete the `mcp-gateway` item and only the `mcp_*` fields
   listed above. Leave the CLI fields alone.

Partial teardown (retiring just `gws-mcp` and `freeagent-mcp` once the
gateway has proven itself) is steps 1, 3, 4 for those two workers, plus
trimming the `gws-mcp.xing.works` and `freeagent-mcp.xing.works` redirect
URIs from the two upstream apps — **keeping the apps, their secrets, and
every user consent**, since the gateway authenticates through exactly the
same `gws-mcp` client and `freeagent-mcp` app. Skip step 2 entirely there:
revoking consent would knock the gateway's own linked accounts offline.
Also drop the retired workers' entries from
[`secrets.manifest.json`](../tools/mcp-workers/secrets.manifest.json).
