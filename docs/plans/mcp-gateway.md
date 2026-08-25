# Plan: mcp-gateway — one MCP endpoint, all connectors behind it

A single hosted MCP endpoint that claude.ai (or any MCP client) connects to
once, with a management interface deciding which services and accounts are
exposed through it. This folds the per-service workers of
[mcp-workers.md](mcp-workers.md) into one gateway worker and supersedes that
plan's phases 3–5 (write tools, WhatsApp, multi-account). Phases 0–2 shipped
as designed; their code becomes the gateway's service modules and their
workers stay live until the gateway proves out.

## Why

The per-service design produces one connector per service per account: with
two Google accounts, FreeAgent, and WhatsApp that is five connectors, five
OAuth handshakes, five permission conversations in claude.ai — and every new
agent surface (Desktop, Claude Code, other clients) repeats all five.
The gateway inverts it: one connector, one identity handshake, and service
enablement/account linking move to a web management page owned by us, not to
N reconnect flows.

## What the protocol does and doesn't give us

- **Dynamic tool resolution: first-class.** `tools/list` is answered
  per-session at request time; the server registers tools conditionally
  (we already do this for the write scope). A server declaring
  `tools.listChanged` may push mid-session updates, but client support is
  uneven — claude.ai reliably re-reads the list per conversation/reconnect.
  Design consequence: management-page changes take effect on the next
  conversation, and that is fine.
- **Layered/gateway resolution: by pattern, not by spec.** MCP has no
  federation primitive; a gateway is an ordinary MCP server whose catalog is
  assembled from modules and whose handlers forward to upstreams. The flat
  tool namespace means names must be unique across the whole catalog, and an
  oversized catalog degrades the model's tool selection — the management
  page's per-service toggles are the pressure valve.
- **Accounts: no protocol concept at all.** A session has one authenticated
  principal (the gateway grant). Accounts are modeled by us: an `account`
  parameter on multi-account tools, a `gateway_list_accounts` tool, and a
  management-set account per service so single-account use never notices the
  parameter. Gmail and Drive share one Google link but resolve independently:
  the mail account and the Drive account are routinely different, so the pin
  is per catalog service, not per namespace. (Alternatives considered: name-duplicated tools per account —
  catalog explosion; per-account path-prefix connectors — kept as the
  escape hatch below, but it is the opposite of the single-endpoint goal.)

## Architecture

One worker (`gateway-mcp`, single `/mcp` endpoint, `workers_dev` off, custom
domain). Three cooperating parts:

1. **Connector OAuth** — unchanged machinery: `workers-oauth-provider` gives
   the MCP client DCR + PKCE + KV grants. The upstream identity is a Google
   sign-in with identity-only scopes (`openid email`), gated by the email
   allowlist. The grant's encrypted props carry *identity and permission
   tier only* — no upstream service tokens. The consent page keeps the
   "allow write tools" checkbox → `read` vs `read write` scope.
2. **User vault DO** — one Durable Object per allowlisted identity, SQLite
   holding: linked accounts (service, account label, upstream refresh token,
   granted scopes, enabled flag, per-service default), service toggles, and
   the audit log (timestamp, tool, arg summary, upstream status). Upstream
   refresh tokens move here from grant props — this is the structural change
   that makes "enable Drive later" and "N accounts" possible without
   reconnecting the connector. Vault rows holding tokens are encrypted with
   a worker secret (same posture as the provider's encrypted props), so KV/
   SQLite at rest never holds plaintext refresh tokens.
3. **Session McpAgent DO** — on session init, reads the caller's vault
   config and registers tools for enabled services only; write tools only
   when the grant carries `write`. Tool handlers resolve
   `(service, account) → access token` through the vault (per-service token
   refresh models carry over unchanged: Google in-memory ~1h refresh,
   FreeAgent refresh-when-<24h-remain — now against vault state instead of
   grant props).

**Service modules** are the existing tool surfaces, lifted as-is from the
per-service workers into `tools/mcp-workers/gateway/` imports: freeagent
(10 reads, writes in a later phase), gmail (9r+8w), drive (3r+3w), later
whatsapp and calendar. Every tool carries its service as a prefix
(`gmail_search`, `drive_read_file`, `freeagent_bank_accounts_list`,
`whatsapp_list_chats`, `gateway_ping`) — unique across the merged catalog, and
legible in a client that shows a flat list of forty tools — and
`readOnlyHint`/`destructiveHint`/`confirm` semantics are unchanged.

**Management interface** — a small web app on the same worker (`/manage`),
authenticated by the same Google sign-in + allowlist (own session cookie;
no dependency on the MCP grant). Actions: link an account (kicks off the
service's upstream OAuth with the scopes the enabled capabilities need;
callback stores the refresh token in the vault), unlink/revoke, toggle
services, set per-service default account, view the audit log. Linking
keeps the per-service owner gates (FreeAgent company check; Google email
must itself be allowlisted or explicitly added). Cloudflare Access in front
of `/manage` is a possible hardening layer later, but must never cover the
MCP handshake paths (known claude.ai breaker); the shared Google sign-in is
sufficient to start.

## Permission layers

Three, from coarse to fine:

1. Connector grant scope (`read` vs `read write`) — set at connect time,
   changed by reconnecting.
2. Management-page enablement — which services and accounts exist in the
   catalog at all; changed any time, effective next conversation.
3. Client per-tool permissions — steered by annotations exactly as today
   (reads on always-allow, writes prompt, destructive confirm).

One honest limitation: with `account` as a parameter, the client's per-tool
permission cannot distinguish accounts — "always allow `gmail_search`"
covers every linked mailbox. If an account is ever materially more
sensitive than the rest, put it on its own path-prefixed connector
(`/acct/<label>/mcp` on the same worker, own grant, own permission
decisions) instead of into the shared catalog. That option stays designed-in
as the escape hatch, not the default.

## Migration and folding

- freeagent-mcp and gws-mcp stay live and untouched while the gateway is
  built; the claude.ai connector swap happens per service only after parity
  verification, after which the old worker (and its KV namespace and DO
  classes) is deleted. Their OAuth clients are *reused* by the gateway
  (redirect URI list gains the gateway's callback) — they are already
  dedicated to the hosted path.
- Secrets fold into one manifest entry for the gateway worker (Google client,
  FreeAgent client, allowlist, vault encryption key) via the existing
  `op-cf-secrets.sh` flow. This is also the point where the account-level
  Secrets Store stops mattering: with one worker there is nothing to share.
- op-mcp and the local CLIs remain untouched, as ever — different medium.

## Phasing

- **G0 — gateway skeleton.** Worker + connector OAuth (Google identity,
  allowlist), vault DO with encryption, session McpAgent reading vault
  config, `/manage` with sign-in + service toggles, `gateway_list_accounts` +
  a ping tool. Verify the claude.ai handshake and that toggling a service
  changes the next session's catalog.
- **G1 — Google services fold-in.** Gmail + Drive modules with the
  `account` parameter and the linking flow; link two accounts (the
  multi-account milestone the old plan deferred to phase 5). Parity-check
  against gws-mcp, swap the connector, retire gws-mcp after a probation
  week.
- **G2 — FreeAgent fold-in.** Reads first, company gate at link time.
  Retire freeagent-mcp the same way.
- **G3 — writes + audit** (old phase 3): FreeAgent bill/explanation/expense
  create, explanation approve/delete with `confirm`; audit log surfaced in
  `/manage`; negative tests (read grant sees no writes, disabled service
  invisible, foreign identity 403, unlinked-account calls fail cleanly).
- **G4 — WhatsApp** (old phase 4, unchanged in substance): the Baileys
  bridge-DO spike, then the bridge DO as its own object with the gateway's
  whatsapp module calling it over a DO binding; pairing page lives under
  `/manage`. Send tools last.
- **G5 — reassess**: calendar module, more accounts, sensitive-account
  path-prefix connectors if needed, home WhatsApp bridge retirement after
  probation.
- **G6 — byte relay, both directions.** The gateway holds every account's
  tokens, so it can move a file between two of them without the bytes
  crossing a conversation as base64 — which at roughly 0.66 tokens per byte
  is the difference between a routine that works and one that spends its
  whole budget on plumbing. Inbound shipped first
  (`drive_save_gmail_attachment`, `drive_save_whatsapp_media`); outbound is
  `gmail_create_draft`'s `drive_attachments`, which fetches with the Drive
  account and attaches with the mail account. The same phase adds in-thread
  replies: given a parent message id the gateway reads its Message-ID and
  References itself and derives `Re: <subject>`, because a caller that has to
  assemble threading headers by hand will get them wrong and Gmail will
  silently start a new thread. Attachment-bearing drafts go out over
  `drafts.create` with `uploadType=multipart` (Draft metadata part carrying
  `threadId`, `message/rfc822` media part) rather than base64url in a JSON
  field. Still no send tool, in this phase or any other.


## Verification

Everything from mcp-workers.md still applies (inspector, metadata
`resource` match, refresh survival, negative gates, flake check). Gateway
additions: a service toggled off mid-conversation fails closed on the next
call; vault rows are ciphertext when inspected via the storage API; a
second linked account routes correctly by `account` and by default; audit
entries appear for every write; the old workers keep serving during the
probation overlap.

## Open questions

- Whether `list_changed` is worth emitting at all (harmless, but untestable
  against claude.ai's behavior — decide during G0).
- Vault DO granularity: one DO per identity (current design) vs one global
  DO — per-identity wins on blast radius and is no harder; revisit only if
  cross-user features appear (none planned; this is a single-owner system).
- Whether the WhatsApp bridge-DO's message store stays in its own DO
  (current design: yes — the gateway module is a thin client over a DO
  binding, so bridge lifecycle stays independent of gateway deploys).
