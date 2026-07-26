---
name: llm-pacer
description: Queue and pace local OpenAI-compatible LLM requests when an upstream is request-rate-limited rather than token-metered.
---

# llm-pacer

Use `llm-pacer` when a latency-insensitive agent must keep waiting for a turn
instead of failing on a provider request-rate limit. It provides one local
OpenAI-compatible provider, a bounded in-memory FIFO, globally spaced starts,
limited upstream concurrency, conservative transient retries, adaptive slowdown,
and JSON/SSE passthrough.

Do not use it for token-per-minute accounting, durable task recovery, workflow
orchestration, multi-account rotation, or multiple independent quota domains in
one process. Run one instance per upstream credential/quota domain.

For Home Manager settings, lifecycle operations, OpenCode examples, mock-only
test commands, and rollback, read `docs/llm-pacer/operator-guide.md` in the
toolbox repository.

## Secret boundary

Clients receive only the loopback base URL, a distinct local token, and an
allowed model ID. Only the daemon reads the upstream API key.

- Never pass either token in argv, generated Nix, a config file, stdout, or a
  transcript.
- Under Home Manager, start with `llm-pacer-start`; it pipes `safe-op` output
  into private systemd credential staging.
- If `llm-pacer.service` is already active, the starter exits successfully
  before contacting 1Password. Do not restart a running unit merely because the
  vault is locked.
- Launch OpenCode with `llm-pacer-opencode`; it injects only the local token into
  the new OpenCode process. The upstream token never enters OpenCode.
- Locking 1Password after startup does not affect either already-running process.

Never use `systemctl --user restart llm-pacer.service`. An intentional restart
is `systemctl --user stop llm-pacer.service` followed by a new interactive
`llm-pacer-start`, because the staged credential sources are ephemeral.

## Agent-facing commands

All finite command output is JSON. Add `--human` only to indent that JSON.

```bash
llm-pacer check-config --config /path/to/config.json
llm-pacer export-models --config /path/to/config.json
llm-pacer export-models --config /path/to/config.json --format opencode
```

The live standard discovery interface is authenticated `GET /v1/models`, with
individual retrieval at `GET /v1/models/{id}`. The configured catalog is also
the inference allowlist. There is no universal provider-registration standard;
the Home Manager plugin registers provider `llm-pacer` for OpenCode and maps the
catalog into OpenCode model metadata.

Use OpenCode through the secret-safe launcher:

```bash
llm-pacer-start
llm-pacer-opencode models llm-pacer
llm-pacer-opencode run --model llm-pacer/<catalog-model-id> "Your request"
```

The plugin disables short request and response-header timeouts. Admitted calls
keep their inbound connection open while queued; no synthetic progress event is
emitted before the upstream response begins.

`serve` is normally owned by the systemd user unit. Direct invocation requires
non-secret credential file paths in:

- `LLM_PACER_UPSTREAM_API_KEY_FILE`
- `LLM_PACER_LOCAL_API_KEY_FILE`

Use `credential-write` only as a pipe consumer in a private runtime directory:

```bash
safe-op read 'op://Fake/Example/credential' --no-newline |
  llm-pacer credential-write "$private_destination"
```

Never invoke `safe-op read` bare or redirect its output with `>`.

## HTTP behavior

- Inbound base URL: `http://127.0.0.1:4000/v1` by default.
- Auth: `Authorization: Bearer <local token>`.
- Queue overflow: local HTTP 429 with `Retry-After`, `retry-after-ms`, and error
  code `proxy_queue_full`.
- Admitted requests intentionally keep their HTTP connections open while
  waiting. Configure clients without short request/header timeouts.
- A client disconnect cancels queued or active work.
- `/healthz` is unauthenticated and contains only aggregate, non-secret state.
- Only model-bearing `POST` inference requests cross the proxy. Known management
  routes, encoded paths, ambiguous or compressed bodies, and model IDs outside
  the configured catalog fail locally.
- Admission happens before body reading. Unknown-length uploads reserve the
  complete per-request body allowance while they wait.
- Retryable upstream statuses are paced. Transport failures are replayed only
  when explicitly classified as transient and pre-request; ambiguous `POST`
  failures and interrupted streams are never replayed.

## Exit codes

- `0`: success or successful exec replacement.
- `1`: runtime, credential, output, startup, or service failure.
- `2`: usage or non-secret configuration failure.

Errors are structured JSON on stderr. Logs contain request IDs, routes, model
IDs, aggregate queue state, statuses, delays, and durations; they do not contain
tokens, prompts, or response bodies.
