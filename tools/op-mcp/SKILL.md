---
name: op-mcp
description: MCP server for Google Workspace (gws) and FreeAgent with 1Password-held tokens. Reads execute directly; writes become plans only a human can run. Use its MCP tools when the service is running; fall back to op-gws/op-freeagent otherwise.
---

# op-mcp

A long-lived MCP service holding OAuth tokens for the 1Password-backed CLIs. A
human starts it and authorizes one 1Password read; after that, agents connected
over its Unix socket can use Google Workspace and FreeAgent **without any
unlock**, for as long as the service runs. No tool ever returns a token, and
there is no generic `op read` tool.

## Tools (over MCP)

- `gws(account?, args)` — run the gws CLI for a configured Google account.
  Omit `account` for the default.
- `freeagent(args)` — run the freeagent CLI.
- `plan_list()` / `plan_status(id)` — read-only views of pending and past plans.

`gws` and `freeagent` results are JSON: `{"status": "ok", "exit_code", "stdout",
"stderr"}` for executed reads, `{"status": "planned", "plan", "message"}` for
calls that became plans, `{"status": "error", "error"}` otherwise.

## Reads are ordinary, writes yield plans

Each toolset has a **read allowlist** (initially: gmail search/get/attachment
fetch, drive list/download, calendar list; freeagent `<resource> list|get` and
the report commands `balance-sheet`, `profit-and-loss`, `trial-balance`).
Classification is default-deny:

- A call matching the allowlist executes immediately.
- **Any other call is not executed.** It is recorded as a *plan* — one business
  action with named steps — and the tool returns `status: "planned"`.

When you get a plan back:

- **Never attempt to execute the plan.** Not via this server, not by invoking
  `op-mcp plan run`, not by driving a terminal. Plan execution is a human act:
  the owner reviews every step in a terminal and confirms.
- Relay the plan id to the user: they review with `op-mcp plan show <id>` and
  execute with `op-mcp plan run <id>` (or discard with `op-mcp plan reject <id>`).
- If your call was actually a *read* that is missing from the allowlist, say so:
  the user can extend the toolset's `extraReads` config. Relay the rejection;
  do not retry with reworded arguments hoping to slip through.

Compose multi-step business actions deliberately: pass `plan_name` (and
`rationale`) on the first write call, then `plan_id` on subsequent calls to
append steps to the same plan. Plans expire after a TTL (default 7 days).

## Lifecycle (human, in a terminal)

- `op-mcp start` / `op-mcp stop` / `op-mcp status` — drive the systemd user
  unit; on hosts without one, `status` still probes the socket and `start`
  tells the user to run `op-mcp serve` in a terminal.
- Starting the service triggers a 1Password desktop-app prompt; only a present
  human can approve it. Do not start the service yourself and expect it to
  work unattended — if the service is down, tell the user.
- When the service is not running, the classic CLIs (`op-gws`,
  `op-freeagent`) remain the fallback; each call needs a 1Password
  authorization.

## Exit codes (CLI)

- `0` ok · `1` runtime failure · `2` credential problem · `3` usage/config
  error · `4` service or systemd unavailable · `5` denied or aborted

## Limits

- The socket only admits processes of the same user whose ancestry includes an
  allowlisted agent binary; the bridge (`op-mcp connect`) must be spawned by
  the agent itself, as an ordinary stdio MCP server, and connects at spawn.
- Same-UID isolation on Linux is a bar-raiser, not a wall; the plan/confirm
  step is the real write barrier.
- Plans store argv and results on disk (no secrets); do not put secret values
  in plan names, rationales, or step arguments.
