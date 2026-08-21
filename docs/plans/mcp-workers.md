# Plan: mcp-workers — hosted MCP connectors on Cloudflare Workers

> **Superseded in part** (2026-08-21): phases 3–5 and the one-worker-per-
> service direction are folded into [mcp-gateway.md](mcp-gateway.md) — a
> single gateway endpoint with a management interface. Phases 0–2 shipped as
> written here and their workers stay live until the gateway reaches parity.

Remote MCP servers for the toolbox connectors (FreeAgent, Google Workspace,
WhatsApp), connectable from claude.ai and Claude Desktop as custom connectors
with a web-driven OAuth flow. The local CLIs, op-mcp, and the local WhatsApp
stack stay untouched until each hosted piece is proven; op-mcp keeps its role
afterwards (different medium: local exec-style access with plan-gated writes).

## Shape

One npm workspace at `tools/mcp-workers/` (root lockfile; AGENTS.md forbids
manifests only at the repository root): `shared/` (OAuth glue, scope
enforcement, consent page, audit), plus one directory per worker —
`freeagent/`, `gws/`, `whatsapp/`. Each worker is an `McpAgent` (agents SDK,
SQLite-backed Durable Object, Streamable HTTP) wrapped by
`@cloudflare/workers-oauth-provider`: the worker is an OAuth *server* to the
MCP client (dynamic client registration, KV-backed grants with encrypted
props) and an OAuth *client* to its upstream IdP.

Everything sits in the Workers free tier. The only tight budget is Durable
Object duration for the WhatsApp socket, handled by the intermittent
connection model below.

## Read/write separation

One MCP endpoint per worker (`/mcp`), one connector in claude.ai. Write
access is decided at OAuth consent time and enforced server-side:

- Consent page has an "allow write tools" checkbox, default off. Unticked →
  the grant carries scope `read` and the write tools are never registered
  for that session; there is nothing client-side to bypass. Ticked → scope
  `read write`, write tools registered alongside the reads.
- Escalating or dropping write access = reconnect the connector and toggle
  the checkbox.
- Per-call friction for writes is the client's tool-permission system,
  steered by MCP tool annotations: every read tool carries
  `readOnlyHint: true` so reads can sit on always-allow while writes prompt
  per call.

(The original design used a second `/rw` endpoint as a distinct connector;
it duplicated the whole read surface per worker and was dropped — the
consent-time scope plus conditional registration is the same server-side
enforcement without the duplication. Trade-off accepted: with writes
approved at consent, an active session always sees the write tools; the
per-call barrier is the client prompt, not a deliberately-attached second
connector.)

Write safety on top: claude.ai's per-tool approval, an audit log in DO
SQLite, no send/delete tools initially, and `confirm: true` parameters on
destructive tools. This is deliberately weaker than op-mcp's
human-runs-the-plan gate; the medium differs (a human is present in the
chat) and the reduced write surface is the compensation.

## Identity

Only the owner may complete an OAuth flow (client registration is open by
protocol design):

- gws: upstream Google sign-in; the callback checks the authenticated email
  against an allowlist secret.
- freeagent: upstream FreeAgent OAuth; after token exchange the worker fetches
  the company record and matches it against a secret, else a stranger could
  bind their own FreeAgent account.
- whatsapp: no upstream exists; Google sign-in is used purely as identity,
  same allowlist.

## Secrets

1Password is the source of truth. A manifest-driven sync tool
(`tools/mcp-workers/scripts/op-cf-secrets.sh` + `secrets.manifest.json`) maps
`op://…` references to env var names and is run manually from a persistent op
shell at deploy/rotation time; the manifest contains references only and is
safe to commit. The current backend is classic per-worker secrets
(`wrangler secret bulk`, values piped, never on argv); the account-level
Secrets Store (beta, bound via `secrets_store_secrets`) slots in behind the
same manifest once a secret is actually shared across workers. Grants and upstream tokens
are runtime state in KV owned by workers-oauth-provider and are never synced
back to 1Password; the workers use their own OAuth clients, so the CLI items'
refresh tokens are never contended.

## Workers

- **freeagent-mcp** — reads: bills/expenses/bank transactions/bank accounts/
  categories/contacts list+get, balance sheet, profit and loss, trial
  balance. Writes: bill create, explanation create/approve/delete (delete
  takes `confirm`), expense create. Endpoints hardcoded (no OIDC discovery):
  `/v2/approve_app`, `/v2/token_endpoint`, `client_secret_basic`. Uses a
  second registered app so revocation is independent of the CLI's.
- **gws-mcp** — reuses the CLI rollout's existing OAuth client (its redirect
  URI list gains the Worker's /callback); `access_type=offline&prompt=consent`.
  Upstream scopes are minimized per grant: read-only grants request only
  `gmail.readonly drive.readonly` (+`openid email` for the gate); write
  grants add `gmail.compose gmail.modify gmail.labels gmail.settings.basic
  drive`. Never request `cloud-platform`: Workspace accounts then die on
  Google Cloud session reauth (RAPT). Google tokens live ~1h, so the DO
  refreshes in-process from the grant's refresh token (Google does not
  rotate refresh tokens). Reads: gmail search/get message/thread/labels/
  drafts/attachment (1MB cap), drive search/get/read (native files export to
  text/CSV, 1MB cap). Writes: draft create (no send tool exists), message
  label modify, label create/rename/delete, filter list/create/delete,
  drive file/folder create, drive update (rename/move/content), drive
  trash. Deletion is trash-only (30-day recovery; no permanent delete);
  label/filter delete and trash require `confirm: true` and carry
  `destructiveHint`. Drive content updates are recoverable via revisions —
  full history for Google-native files, ~30 days for uploaded binaries — so
  update is a plain write. Calendar tools deferred. One account first;
  multi-account later via per-account path prefixes.
- **whatsapp-mcp** — full-cloud reimplementation of the bridge on Baileys
  (TypeScript WhatsApp Web library) in a dedicated Durable Object, paired as
  an *additional* linked device so the home whatsmeow bridge keeps running
  unchanged throughout. Pairing via an auth-gated web page (QR or phone
  pairing code) — no TTY. Connection model is intermittent, never always-on:
  a DO alarm every 5–15 minutes connects, drains the offline queue into DO
  SQLite, disconnects (~8% of the free DO-duration budget; always-on would be
  ~83% and dies on every deploy). Sends connect on demand. Session state
  (Baileys auth state) and the message store live in DO SQLite, mirroring the
  bridge's chats/messages schema, with a one-off import of the existing
  history; media decrypts via WebCrypto, small results inline, large to R2
  with short TTL. `send_audio_message` is not carried over (no ffmpeg);
  pre-encoded `.ogg` via `send_file` is the workaround.
  Accepted trade-offs, eyes open: message history and Signal session keys at
  rest in Cloudflare; a vendored Baileys patch set chasing protocol churn;
  connection-churn fingerprint slightly raises the (already accepted)
  unofficial-client ban risk.
  Plan B if the spike fails on runtime/crypto/session grounds: a small
  home-side HTTP wrapper over the existing Python read queries behind a
  Cloudflare Tunnel with an Access service token; the Worker layer is
  identical either way.

## Phasing

0. Scaffold + connectivity spike: hello-world McpAgent behind the full OAuth
   handshake; claude.ai and Claude Desktop connect and call a dummy tool.
1. freeagent-mcp read.
2. gws-mcp read.
3. Write tools on both + audit log.
4. whatsapp: time-boxed Baileys-on-DO spike (pairing from the web page,
   alarm-driven drain persisting across DO evictions, one image decrypted to
   R2), then the full bridge-DO, history import, read connector; send last.
5. Reassess: more Google accounts; retire the home WhatsApp bridge only after
   the cloud bridge survives a probation period as second linked device.

## Verification

Per worker: MCP inspector against `/mcp`; protected-resource metadata
`resource` exactly matches the connector URL as typed; claude.ai + Desktop
complete OAuth and one real query; the connection survives a token refresh and
7+ days unattended. Negative: non-allowlisted identity → 403 at callback;
a read-only grant lists no write tools; handshake paths free of Access/WAF
interception. Parity spot-checks against the local CLIs. `nix flake check`
gates every push (`checks/mcp-workers` typechecks and unit-tests the
workspace offline from the lockfile).
- Secrets Store is beta; the sync tool keeps a fallback to classic per-worker
  secrets from the same manifest.
- KV namespace recreation invalidates grants (connector shows as needing
  reconnection) — expected behaviour, not breakage.
