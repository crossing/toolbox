# llm-pacer implementation plan

Status: approved for implementation

Branch: `feature/llm-pacer`

This document is the durable implementation contract for `llm-pacer`. It is
intentionally the first commit on the implementation branch; later code and
handoff commits build on it.

## Objective

Build a local OpenAI-compatible reverse proxy for request-rate-limited LLM
providers. The first configured upstream will be NVIDIA hosted NIM, but neither
the product name nor the core behavior is NVIDIA-specific.

Latency-insensitive agents must be able to remain connected while requests wait
for their turn. The proxy strictly limits outbound request starts and concurrent
upstream work, retries transient failures conservatively, and streams responses
without buffering them in full.

Only `llm-pacer` receives the upstream API key. Clients receive only:

- a loopback OpenAI-compatible base URL;
- a distinct local bearer token; and
- a model ID present in the configured model catalog.

## Decisions and constraints

- Tool, binary, service, provider, and Home Manager module name: `llm-pacer`.
- Repository path: `tools/llm-pacer`.
- Go module: `github.com/crossing/toolbox/tools/llm-pacer`.
- The tool is a nested Go module. It must not add dependencies to the repository
  root `go.mod`, and the repository must not gain a root `go.work`.
- Prefer Bifrost Core as the OpenAI/provider adapter if a pinned, Go-compatible
  version preserves the required raw HTTP, streaming, cancellation, and retry
  semantics. Pacing, admission, and adaptive control remain owned by
  `llm-pacer`. Fall back to a small standard-library transport if the fit gate
  fails.
- One process represents one upstream base URL, credential, and quota domain in
  version one. Additional providers use additional instances.
- Bind to loopback by default at `127.0.0.1:4000`.
- Run as a manually started systemd user service exported from the repository's
  post-Snowfall Home Manager surface.
- Startup is intentionally interactive because 1Password may require unlock or
  approval. Do not auto-start, auto-restart, or attach the unit to a target.
- Re-running the starter while the unit is active is a successful no-op and must
  not touch 1Password or replace the process.
- Once started, locking the 1Password vault must not affect the service or an
  already-running OpenCode process.
- Tests use only local scripted mock endpoints. They never call NVIDIA or any
  other paid/real upstream.
- The repository is public: no real keys, account data, prompt content, or
  provider responses enter source, fixtures, logs, or the Nix store.

## External interface

### OpenAI-compatible HTTP

The server accepts authenticated requests below `/v1/` and forwards arbitrary
inference routes while preserving method, query, body, response status, response
body, and streaming chunks. It strips hop-by-hop headers and all inbound
upstream credentials, then supplies the configured upstream bearer token.

Local endpoints are:

- `GET /healthz`: unauthenticated, sanitized liveness and limiter state;
- `GET /v1/models`: authenticated OpenAI model list;
- `GET /v1/models/{id}`: authenticated OpenAI model retrieval; and
- other `/v1/*`: authenticated, model-allowlisted forwarding.

Authentication failures and local rejections use an OpenAI-shaped structured
error. They never echo credentials or request bodies.

### Authoritative model catalog

One strict JSON catalog is both the allowlist and model metadata source. It
contains stable IDs plus optional display name, owner, creation time, context and
output limits, capabilities, and modalities.

`/v1/models` emits standard OpenAI fields and places richer metadata below the
namespaced `x-llm-pacer` extension. The local model endpoints bypass the upstream
queue, pacer, and concurrency limiter.

OpenCode custom providers currently require explicit model configuration rather
than discovering `/v1/models` themselves. The Home Manager integration therefore
installs a zero-dependency local OpenCode plugin that:

1. fetches the authenticated local `/v1/models` endpoint during the public
   asynchronous `config` hook;
2. maps the extension metadata into OpenCode model configuration;
3. leaves a generated static fallback catalog in place if live discovery is
   unavailable; and
4. configures `@ai-sdk/openai-compatible`, the loopback base URL,
   `headerTimeout: false`, and `timeout: false`, while omitting `chunkTimeout`.

The OpenCode acceptance target is the locally installed OpenCode `1.18.5`.

## Request lifecycle

```text
client
  -> authenticate and validate model/body limit
  -> bounded FIFO admission
  -> paced outbound-attempt permit
  -> upstream concurrency permit
  -> upstream adapter/transport
  -> JSON or incremental SSE response
```

### Admission and waiting

- Admitted requests wait FIFO and keep their inbound HTTP connections open.
- Client cancellation removes a waiting request immediately or cancels the
  active upstream request.
- Queue bounds cover count and retained request bytes. A per-request body limit
  prevents one caller from consuming the entire byte budget.
- When any admission bound is exceeded, reject immediately with local HTTP 429,
  error code `proxy_queue_full`, `Retry-After`, and `retry-after-ms`.
- Queue state is in memory and is not durable. Task durability remains the agent
  harness's responsibility.

### Pacing and concurrency

- All outbound attempts, including retries, pass through one serialized pacer.
- Starts are spaced by at least `60 / effective_rpm`; there is no startup burst.
- The configured RPM is a ceiling, not a guarantee of provider capacity.
- A separate semaphore limits active upstream attempts. Streaming responses hold
  capacity until EOF, failure, or downstream disconnect.
- Limiter behavior uses an injectable monotonic clock and deterministic random
  source so timing rules can be tested without flaky wall-clock assertions.

### Retry and adaptive control

Retry 429, 500, 502, 503, and 504 responses, connect failures, and safe protocol
or read failures only before a response has been committed downstream. Do not
retry deterministic 4xx responses or a stream after bytes have reached the
client.

Every retry re-enters the attempt scheduler. Honor both delta/date
`Retry-After` and provider `retry-after-ms` hints, then apply bounded exponential
backoff with jitter. A 429 increases the global pacing interval and resets the
success streak; sustained success gradually returns toward, but never above, the
configured RPM ceiling.

### Streaming and timeouts

- Detect and forward SSE/streaming responses incrementally.
- Flush chunks promptly and never buffer a complete generation.
- Close the upstream response when the client disconnects.
- Default upstream request and stream-idle limits are long enough for overnight
  agent work (1,800 seconds), and client integrations disable shorter harness
  header/request timeouts explicitly.

## Initial defaults

| Setting | Default |
| --- | ---: |
| Listen address | `127.0.0.1:4000` |
| Configured RPM | 32 |
| Maximum upstream inflight | 3 |
| Queue count limit | 128 |
| Maximum configurable queue count | 500 |
| Queued body byte budget | 256 MiB |
| Per-request body limit | 16 MiB |
| Maximum retries | 12 |
| Maximum backoff | 300 seconds |
| Upstream request timeout | 1,800 seconds |
| Stream idle timeout | 1,800 seconds |
| Connect timeout | 30 seconds |
| Minimum adaptive RPM | 1 |

All limits are explicit configuration with validation. Conservative defaults
must not be weakened merely to make a test pass.

## Packaging and service integration

### Nix and Snowfall boundary

The concurrent repository migration to Snowfall Lib owns the flake/module
layout. Core tool work proceeds independently, but package registration and
module exports wait until that layout is stable.

The completed integration exports:

- `packages.<system>.llm-pacer`;
- the existing default overlay entry for `llm-pacer`;
- `homeModules.llm-pacer`; and
- `services.llm-pacer` Home Manager options.

The package builds only the nested module and keeps dependencies isolated from
existing Go tools. `nix flake check` remains the repository gate.

### Interactive 1Password startup

The Home Manager module installs `llm-pacer.service` and
`llm-pacer-start`.

`llm-pacer-start` performs this sequence:

1. If the unit is already active, exit successfully without reading 1Password.
2. Create a mode-0700 staging directory below `$XDG_RUNTIME_DIR`.
3. Pipe `safe-op read` output directly into a credential-staging command; never
   place a secret in argv, a shell variable, stdout, a log, or the Nix store.
4. Start the user unit, which imports credential files with systemd
   `LoadCredential=` and receives only credential file paths.
5. Wait for active state and local health, then remove the source staging files.

The process reads both the upstream API key and local proxy token once at startup
and retains only the values needed in memory. systemd's private credential copy
remains valid for the service lifetime, so later vault locking is harmless.
There is no `WantedBy`, timer, restart policy, or unattended secret lookup.

OpenCode receives the distinct local token through its own interactive
secret-safe launcher. An already-running OpenCode process likewise remains usable
after the vault locks.

## Implementation sequence

Each phase ends with focused verification and a handoff update. Commits remain
small enough to review and revert independently.

1. **Contract and adapter fit**
   - Pin the accepted configuration/schema behavior.
   - Prove or reject a compatible Bifrost Core version against a scripted local
     OpenAI-compatible mock, including raw errors, headers, SSE, and cancellation.
2. **Local catalog and HTTP shell**
   - Implement strict catalog loading, authentication, health, `/v1/models`,
     retrieval, model allowlisting, request IDs, and secret-safe errors/logging.
3. **Admission and scheduling**
   - Implement bounded FIFO admission, byte accounting, cancellation, serialized
     no-burst pacing, and maximum upstream concurrency.
4. **Transport resilience**
   - Add arbitrary route forwarding, header sanitation, bounded retries,
     `Retry-After`, adaptive slowdown/recovery, JSON passthrough, SSE streaming,
     and disconnect cleanup.
5. **OpenCode provider**
   - Add the discovery/config plugin, generated fallback catalog, secret-safe
     launcher, and an isolated OpenCode `1.18.5` acceptance fixture.
6. **Nix, Home Manager, and systemd**
   - Register the package after Snowfall settles, export the Home Manager module,
     add manual service/starter behavior, and verify repeated start and vault-lock
     lifecycle semantics without real secrets.
7. **Full acceptance and handoff**
   - Run unit, integration, concurrency, cancellation, streaming, and load tests;
     build the package; run `nix flake check`; capture exact commands and results;
     document startup, configuration, examples, limitations, and rollback.

## Mock-only verification matrix

The scripted upstream records attempt start timestamps and can produce delayed
JSON, SSE, disconnects, malformed responses, 429s with both retry header forms,
transient 5xx sequences, deterministic 4xx responses, and long-running streams.

Acceptance must prove:

- missing/wrong local tokens return 401 and never reach upstream;
- disallowed models fail locally and model discovery is stable;
- at least 50 simultaneous requests never exceed configured start spacing;
- active upstream work never exceeds the configured concurrency;
- admitted callers wait with live inbound connections and finish in FIFO order;
- queue count, byte, and per-request bounds release correctly on every exit path;
- overflow returns local 429 with retry hints;
- retries consume paced permits, honor hints, and stop at the configured bound;
- 429 slows global pacing and successful calls recover only to the RPM ceiling;
- non-retryable errors retain safe status/body semantics;
- JSON and SSE arrive correctly, streams retain capacity, and disconnects cancel;
- health and structured logs expose useful state but no credentials or bodies;
- the real OpenCode `1.18.5` executable discovers/selects a mock model and
  completes a request without timing out in the queue;
- the service can be started interactively, a repeated starter is a no-op, and a
  running process is independent of subsequent 1Password availability;
- neither the root Go dependency graph nor unrelated tool packaging changes; and
- the package build and full `nix flake check` pass.

## Out of scope for version one

- token-per-minute accounting;
- per-user quotas, billing, or credential rotation;
- multi-host or multi-process coordination;
- durable queue recovery or submit-and-poll jobs;
- multiple quota domains within one process;
- workflow orchestration;
- provider-specific token accounting; and
- automatic service startup or restart.

## Completion handoff

The final handoff records the repository path, branch and commit hashes, startup
and rollback commands, configuration schema, test and load evidence, OpenCode and
curl examples, known limitations, and explicit confirmation that clients never
receive the upstream key. A shorter live handoff file is maintained during
implementation so another thread can resume from verified state at any commit.
