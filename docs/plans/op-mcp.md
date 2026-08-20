# Plan: op-mcp — a presence-scoped MCP service for the 1Password-backed tools

Design agreed in discussion; nothing here is implemented yet. Working name `op-mcp`
(final name open — see Open items).

## Problem

Every `op-` wrapper (`op-gws`, `op-freeagent`, `op-oauth2c`) calls `op item get` per
invocation, and every `op` process needs the 1Password desktop app to authorize it —
physical presence at the machine. The current workaround (a persistent tmux shell per
agent session) is per-session, fragile, and useless for scheduled or unattended work.
`op-gws` additionally caches minted access tokens back into the 1Password item, so
even the cache read costs an unlock.

`ibgateway`/`ibkr-local` already solved this shape for the Gateway: a human is
present once at service start (secrets rendered from `op://` refs, 2FA done
interactively), the long-lived service holds authenticated state, agents use it
freely, and stopping the service wipes the state. This plan applies that pattern to
the OAuth-backed CLIs.

## Design

### One service, presence at start only

A single long-lived MCP server covers all configured toolsets (Google Workspace
accounts, FreeAgent). One service means the expensive thing — the 1Password unlock —
happens once and covers everything.

On start the server **eagerly** reads every configured item via `safe-op`
(`client_id`, `client_secret`, `refresh_token` per account), triggering exactly one
desktop-app authorization while the human is present. Eager, not lazy: a lazy read
mid-run would prompt while nobody is there and fail.

Steady state never touches `op`. Access-token refresh happens in-process against
Google/FreeAgent using the in-memory client credentials, so the vault re-locking
later is irrelevant. Server memory replaces `op-gws`'s write-back token cache. The
one exception: if a provider rotates the refresh token, the server writes it back to
the item immediately (this rare event may prompt; better a prompt than a lost
credential).

On stop: process exits, tokens are gone, the socket is removed. Nothing
secret ever touches disk.

### Transport: Unix socket + per-client stdio bridge

MCP clients (Claude Code, codex, opencode) speak stdio or HTTP-over-TCP only; none
can dial a Unix socket directly (verified 2026-08). Localhost TCP cannot identify
the peer process, so:

- The server listens on a Unix socket at `$XDG_RUNTIME_DIR/op-mcp.sock`, mode 0600.
- Each MCP client entry is a small stdio↔socket **bridge** the agent spawns as an
  ordinary stdio MCP server. The bridge connects immediately at spawn — while its
  agent parent is alive — and holds the connection; it never reconnects lazily,
  because the origin check below happens at connect time.
- No bearer token, no port, nothing on disk to steal: the socket is the only door.

### Origin enforcement: peer-credential ancestry check

At accept, the server takes the peer pid from `SO_PEERCRED` (rejecting any UID but
its own), then walks the `/proc/<pid>` parent chain requiring an **allowlisted agent
binary** as an ancestor, comparing each ancestor's `/proc/<pid>/exe` — the kernel's
ground truth for the running binary. The bridge is a direct child of the agent, so
the walk is typically one hop.

The bridge itself is deliberately *not* trusted — it is a world-readable store path
anyone can exec. An attacker running the bridge (or connecting with their own code)
has no allowlisted agent in their ancestry and is denied either way. Enforcement
lives entirely server-side.

Nix makes the allowlist clean: home-ops knows the exact store paths of the agent
binaries it installs and bakes `allowedClients` into the server config; the list
updates itself on every rebuild.

**Honest limits.** Same-UID isolation on Linux is a bar-raiser, not a wall: a
process running as the user can `LD_PRELOAD` into a genuine agent binary or simply
prompt-inject a real agent, and pid-reuse races during the ancestry walk are
narrow but real (mitigated by re-reading the peer's exe after the walk). This
defends against the realistic threat — arbitrary local processes and unauthorized
tools stumbling into a standing capability — not against a determined attacker who
already runs code as the user.

### Tools: coarse exec-style, capability-scoped

One tool per CLI — `gws(account, args)`, `freeagent(args)` — executing the
underlying binary with the token injected via env exactly as the wrappers do today
(`GOOGLE_WORKSPACE_CLI_TOKEN`, `FREEAGENT_ACCESS_TOKEN`). This preserves the
existing skills investment (the generated gws skills, `patch-gws-skills`,
freeagent's SKILL.md) instead of duplicating hundreds of operations as MCP tools.

**No tool ever returns a token, and there is no generic `op read` tool.** Tokens
live server-side only — a strictly better egress posture than today's
command-substitution discipline.

### Read-through, plan-for-writes

The standing capability the service exposes is **read-only**; writes require the
human. This generalizes `ibkr-local`'s order-entry model (preview → explicit owner
confirmation → execute).

- **Default-deny classification.** Each toolset carries an allowlist of read
  subcommand shapes. Anything not matching is a write — no write blocklist, because
  a missed entry must fail closed, not execute. Initial read allowlist: gmail
  search/get/attachment-fetch, drive list/download, calendar list, and the
  freeagent read surface. Attachment fetch writes bytes locally but is a read of
  the account. Blocked reads fail with an explicit "not in the read allowlist"
  message for the agent to relay; the list grows on demand.
- **Writes return a plan, not a result.** A plan is one **business action** — e.g.
  "Invoice Acme for July + email it" — with a name, an optional area
  (`accounting`, `correspondence`, …), an ordered step list (exact argv per step),
  the agent's rationale, the requesting agent, and a timestamp. Plans hold no
  secrets, so they live on disk under `~/.local/state/op-mcp/plans/`. The tool call
  returns the plan id with status `planned`.
- **Execution requires the human, in a terminal.** `op-mcp plan run <id>` — a human
  CLI, deliberately not an MCP tool — prints every step of the action, asks for
  confirmation of the action as a whole, and executes through the running service's
  in-memory tokens. Presence is enforced by the medium. `plan reject <id>`
  discards; plans expire after a TTL (default 7 days) so an action built against
  stale data cannot linger executable.
- Agents get read-only `plan_list` / `plan_status` tools so they can compose work
  and report what is pending. No batching to dodge review: `run` confirms per
  plan, and a plan shows all of its steps.

### Lifecycle

Manually started, never boot-enabled — a boot-time unlock prompt with nobody
committed to it defeats the purpose. `op-mcp start|stop|status` wrappers (mirroring
the `bootstrap-ibkr-gateway` ergonomics) drive a systemd user unit on NixOS; the
desktop app's GUI prompt appears regardless of the unit having no terminal. An
optional idle timeout auto-stops a forgotten service (default open — see below).

### What stays a CLI

- `op-oauth2c` and `op-gws-onboard`: interactive, one-time, browser-driven.
- `safe-op`: the generic guard for ad-hoc `op` use.
- `op-gws` / `op-freeagent` CLIs: still installed; the interactive path and the
  fallback when the service is not running.

## Implementation

### Phase 1 — toolbox (this repo)

`tools/op-mcp/` per `docs/adding-a-tool.md`:

- Python server on the official `mcp` SDK, packaged with uv2nix (precedent:
  `ibkr-local`'s flex-fetch). Package-local `pyproject.toml`/lockfile under
  `tools/op-mcp/`, never at the repo root.
- The bridge and the `plan`/lifecycle CLI ship in the same package
  (`op-mcp serve|connect|start|stop|status|plan …`).
- Config file (rendered by the consumer): toolsets, accounts→items, vault,
  `allowedClients`, read allowlists, plan TTL, idle timeout.
- Tests: unit tests for classification (default-deny), plan store, ancestry-walk
  logic against a fake `/proc` tree, and a socket round-trip with a peer-cred stub.
  Location-independent per the checklist; register `packages/op-mcp`,
  `checks/op-mcp`, and the SKILL.md in `toolbox-skills`.
- SKILL.md teaches agents: reads are ordinary; writes yield plans; never attempt to
  execute a plan; relay allowlist rejections to the user.

### Phase 2 — home-ops (follow-up PR there)

- `modules/home/services/op-mcp/`: options for toolsets/accounts (same schema as
  `hos.programs.op-gws`), the systemd user unit, config rendering, and
  `allowedClients` derived from the installed agent packages' store paths.
- Register the bridge as an MCP server in the claude/codex/opencode module configs.
- Existing `op-gws`/`op-freeagent` modules unchanged.

## Open items

- Final name (`op-mcp` vs something less 1Password-coupled).
- Idle timeout default (candidate: stop after 12h, or none — run until stopped like
  ibgateway).
- Whether `plan run` re-previews live data before confirming (e.g. re-fetch the
  invoice contact) or trusts the plan's recorded steps as reviewed.

Phase 1 (2026-08) shipped `tools/op-mcp/` with interim choices — the working name
`op-mcp`, idle timeout off by default (`idleTimeoutMinutes = 0`), and no live
re-preview in `plan run` (it shows the plan's recorded steps) — all three items
remain open.

## Non-goals

- Remote access (e.g. from `gk` over SSH): out of scope; the service binds a local
  socket on the desktop only.
- Fine-grained per-operation MCP tools mirroring the gws/freeagent surfaces.
- Replacing sops-nix or the machine-level secret story; this is user-session OAuth
  only.
- A hard security boundary against same-UID attackers (see Honest limits).
