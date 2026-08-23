# mcp-workers handoff

State of the hosted-MCP migration as of 2026-08-21, written for whoever picks
this up next (human or agent). The design rationale lives in
[mcp-workers.md](mcp-workers.md); this is the operational state. The full
inventory of what exists outside this repo — Workers, KV, Durable Objects,
custom domains, upstream OAuth apps, 1Password fields — and the order to
delete it in lives in [../mcp-workers-infra.md](../mcp-workers-infra.md).

## What is live

Two Workers, both deployed, both verified end-to-end from claude.ai as custom
connectors (OAuth handshake, real tool calls against live data):

| Worker | URL | Tools | Status |
|---|---|---|---|
| freeagent-mcp | `https://freeagent-mcp.xing.works/mcp` | 10 read + `ping_write` spike | Phase 1 done |
| gws-mcp | `https://gws-mcp.xing.works/mcp` | Gmail 9r+8w, Drive 3r+3w | Phase 2 done |
| gateway-mcp | `https://mcp.xing.works/mcp` | gateway_ping, gateway_list_accounts, Gmail 9r+8w, Drive 3r+3w (with `account` param), FreeAgent 11r+5w, WhatsApp 10r+3w — every tool prefixed with its service | G3 done; G4 paired and live (see g4-whatsapp.md) |
| whatsapp-bridge | no HTTP surface | hosts the WhatsApp bridge Durable Object | G4; reached only over the gateway's cross-script DO binding |

Work happens on branch `feature/mcp-workers` in a dedicated worktree
(`git worktree list`); the branch is pushed with a PR open to master.
`nix flake check` is green.

The gateway's `/manage` page owns Google account linking: a link stores the
approved account's refresh token AES-GCM-encrypted in the owner's vault DO
(read-only or read+write scopes per a checkbox at link time), unlink revokes
the upstream grant best-effort, and the per-service default account serves
tools called without an `account` argument. Linked accounts must themselves
be on `ALLOWED_EMAILS`. FreeAgent links are company-gated instead
(`ALLOWED_COMPANY` vs the subdomain fetched with the new grant); their vault
blobs persist the full token set because FreeAgent access tokens live ~7
days and the refresh token may rotate on use — every in-DO refresh writes
the rotated set back.

Every write tool across all gateway services runs through `auditedServer`:
each call (including confirm-refusals and failures) lands in the owner's
vault audit log with a capped argument summary, and `/manage` renders the
50 most recent entries. Auditing is best-effort — it never fails a call.

## Architecture recap (what you must not regress)

- **Single `/mcp` endpoint per worker.** There is no `/rw`; that design was
  dropped (freeagent DO migration v2 renamed/deleted the old classes). Write
  access is granted at the consent page ("allow write tools" checkbox →
  `write` scope) and enforced server-side by conditional tool registration.
  Every read tool carries the MCP annotation `readOnlyHint: true`; claude.ai
  groups tools by it, letting reads sit on Always-allow while writes prompt
  per call. Destructive tools additionally carry `destructiveHint` and
  require `confirm: true` (delete label/filter, drive trash).
- **No dangerous surface**: no email-send tool exists at all (drafts only);
  Drive deletion is trash-only (30-day recovery, no permanent delete).
  Drive content updates are revision-recoverable (full history for
  Google-native files, ~30 days for uploaded binaries) so update is a plain
  write.
- **Owner gates at `/callback`**: FreeAgent grants require the company
  subdomain to match `ALLOWED_COMPANY`; Google grants require the account
  email to be in `ALLOWED_EMAILS` (comma-separated). Strangers can log in
  upstream but never mint a grant.
- **Upstream token lifecycles differ deliberately**:
  - FreeAgent tokens live ~7 days → refreshed inside the OAuth provider's
    `tokenExchangeCallback` when <24h remain (the callback gets no `env`, so
    the default export captures it per-request — keep that wrapper).
  - Google tokens live ~1h → refreshed in-DO by `TokenSource` from the
    grant's refresh token (Google does not rotate refresh tokens; nothing is
    written back to the grant).
- **Upstream scopes are minimized per grant** (gws): read-only grants ask
  Google only for the readonly scopes. Never add `cloud-platform` (Workspace
  accounts then die on RAPT reauth — see op-oauth history).

## Secrets

1Password is the source of truth; `tools/mcp-workers/secrets.manifest.json`
maps env var names to `op://` references per worker;
`tools/mcp-workers/scripts/op-cf-secrets.sh <worker>` resolves and pushes
them via `wrangler secret bulk` (values piped, never on argv). Run from the
persistent op shell:

```
CLOUDFLARE_API_TOKEN=$(op read "op://Private/cloudflare.com/api_token_wrangler-mcp-workers") \
  ./scripts/op-cf-secrets.sh gws
```

A secret push auto-deploys a new worker version. Rotation = roll upstream,
paste the new value into the referenced 1Password field (via the 1Password
app, keeping it out of terminals/transcripts), re-run the sync. Both
upstream client secrets were rolled after initial setup; the FreeAgent and
Google clients in use are dedicated to these workers (independent
revocation from the CLIs').

## Deploy / infra

- Deploy: `npm run deploy:freeagent` / `npm run deploy:gws` from
  `tools/mcp-workers/` with `CLOUDFLARE_API_TOKEN` as above.
- Custom domains are attached once via the Workers Domains API
  (`PUT /accounts/{account}/workers/domains`), NOT via wrangler routes — the
  deploy token deliberately has no zone permissions. `workers_dev: false`
  keeps the OAuth issuer URL single and stable.
- Each worker has its own OAuth KV namespace (ids in the wrangler.jsonc
  files). Losing one invalidates grants; connectors just reconnect.
- Observability is enabled; query logs via
  `POST /accounts/{id}/workers/observability/telemetry/query` (the MCP
  observability plugin's response validation is broken — use the raw API).

## Gotchas that cost real debugging time

- Never call a detached `fetch` in workerd — "Illegal invocation". Use
  `boundFetch` from `@toolbox/mcp-shared` (Node/vitest tolerates the bug, so
  tests won't catch a regression).
- FreeAgent's token endpoint answers ANY invalid/expired grant with
  `401 text/html "HTTP Basic: Access denied."` even with valid client creds
  — not proof of bad credentials. Google returns proper JSON
  (`invalid_client` vs `invalid_grant` distinguishes).
- FreeAgent authorization codes are single-shot and short-lived; redo the
  approve flow rather than reusing a stale code.
- The `agents` npm package needs its optional `ai` import aliased to
  `shared/src/ai-stub.ts` in each wrangler.jsonc, or every request hangs
  with no error.
- The nix check must use `buildNpmPackage` + `importNpmLock.npmConfigHook`
  (`buildNodeModules` skips workspace deps). Node major is pinned.
- The flake only sees tracked files — `git add` before `nix flake check`.

## Remaining phases

G4 (WhatsApp) is **done**: the bridge Worker, the Durable Object, ten read
tools plus text and file send, `/manage/whatsapp` for pairing and health, and a
history importer. A device is paired and the ten-minute sync cycle is running.
Pairing is QR-first; the phone-code flow is kept as a fallback. See
[g4-whatsapp.md](g4-whatsapp.md).

Next up, not started: [aaisp-sms.md](aaisp-sms.md) — an AAISP SMS receive hook
and `sms_*` tools on the same gateway.

Superseded: the original phases 3–5 (writes, WhatsApp, multi-account) are
folded into the gateway plan — see [mcp-gateway.md](mcp-gateway.md) for the
current phasing (G0–G5). The two live workers above keep serving until the
gateway reaches parity per service, then retire.

Also pending: push the branch + PR to master; local CLIs/op-mcp/WhatsApp
stack stay untouched until then (and after — different medium).
