# llm-pacer operator guide

`llm-pacer` is a loopback-only OpenAI-compatible provider for LLM upstreams
that limit request starts. It admits a bounded number of requests, keeps each
admitted HTTP connection open in a FIFO queue, spaces every upstream attempt,
limits concurrent upstream work, and retries selected upstream status responses
plus only demonstrably pre-request transport failures.

NVIDIA hosted NIM is the first intended upstream, but the daemon and its model
catalog are provider-neutral. One daemon process represents one upstream base
URL, credential, and quota domain.

Only the daemon can read the upstream credential. Clients and OpenCode receive
only a distinct local token, the loopback URL, and allowed model IDs.

## Discovery contract

There is no universal cross-harness provider-registration protocol. The common
wire interface is the OpenAI Models API:

- authenticated `GET /v1/models` lists the configured models;
- authenticated `GET /v1/models/{id}` retrieves one model; and
- `llm-pacer export-models` emits the same catalog without a running daemon.

The model catalog is both discovery metadata and the inference allowlist.
Harnesses that support custom OpenAI-compatible providers can use the loopback
base URL, local bearer token, and model ID directly. OpenCode needs its provider
registered explicitly, so the Home Manager module installs a plugin that turns
the catalog into an OpenCode provider.

## Safe, fake standalone configuration

This complete example points at a nonexistent local mock port and contains no
credentials. Save it outside the repository if modifying it for real use.

```json
{
  "listen": "127.0.0.1:4000",
  "upstream_base_url": "http://127.0.0.1:9999",
  "rpm": 32,
  "max_inflight": 3,
  "queue_limit": 128,
  "max_queued_body_bytes": 268435456,
  "max_request_body_bytes": 16777216,
  "max_retries": 12,
  "max_backoff": "300s",
  "upstream_request_timeout": "1800s",
  "stream_idle_timeout": "1800s",
  "connect_timeout": "30s",
  "min_adaptive_rpm": 1,
  "models": {
    "acme/mock-model": {
      "name": "ACME Mock Model",
      "owner": "acme-test",
      "created": 0,
      "limits": {
        "context": 8192,
        "output": 2048
      },
      "capabilities": {
        "tool_call": false,
        "reasoning": false,
        "attachment": false,
        "temperature": true
      },
      "modalities": {
        "input": ["text"],
        "output": ["text"]
      }
    }
  }
}
```

Unknown fields are rejected. The listen address must be literal loopback or
`localhost`. The upstream must be an absolute HTTP(S) URL without credentials,
query, or fragment. Both model token limits must be set together, and supported
modalities are `text`, `audio`, `image`, `video`, and `pdf`.

Validate and inspect a non-secret configuration with:

```bash
llm-pacer check-config --config ./llm-pacer.json --human
llm-pacer export-models --config ./llm-pacer.json --format openai --human
llm-pacer export-models --config ./llm-pacer.json --format opencode --human
```

For an upstream such as NVIDIA NIM, the complete inbound `/v1/...` path is
appended to `upstream_base_url`. Use a prefix such as
`https://integrate.api.nvidia.com`, not a URL already ending in `/v1`, unless
the upstream genuinely expects two version segments.

## Forwarded inference boundary

`llm-pacer` is an inference proxy, not a general authenticated forward proxy.
This final fail-closed policy supersedes the historical plan's broader
forwarding and response-read retry assumptions; the plan remains unchanged as a
decision record.
It forwards only `POST` requests that have exactly one allowlisted top-level
`model` field:

- identity-encoded JSON under `/v1/...`, except known management namespaces;
- multipart audio transcriptions and translations; and
- multipart image edits and variations.

It rejects missing, duplicate, or disallowed model fields; compressed or opaque
request bodies; encoded route paths; dot or backslash path segments; and known
management routes. This fail-closed boundary prevents a local-token holder from
using the daemon to reach arbitrary upstream administration endpoints. The
daemon still passes the accepted request and response payload through without
trying to translate one provider's inference schema into another.

Admission occurs before reading the body. A known `Content-Length` reserves its
declared bytes; an unknown or chunked length reserves the configured per-request
maximum. This keeps slow uploads inside the same count and byte bounds as queued
and active work. A slow authenticated client can occupy an admitted slot, but it
cannot escape the configured admission count or retained-body accounting.

## Home Manager configuration

Import the public module from the toolbox flake input. Replace `toolbox` with
the input name used by the consumer, and replace every `Fake` or `example`
value before deployment.

```nix
{ inputs, ... }:
{
  imports = [ inputs.toolbox.homeModules.llm-pacer ];

  services.llm-pacer = {
    enable = true;

    upstreamBaseURL = "https://integrate.api.nvidia.com";
    requestsPerMinute = 32;
    minAdaptiveRequestsPerMinute = 1;
    maxInflight = 3;
    queueLimit = 128;

    # These are 1Password references, never secret values.
    upstreamCredentialRef = "op://Fake/LLM upstream/credential";
    localCredentialRef = "op://Fake/LLM pacer local token/credential";

    models."vendor/example-model" = {
      name = "Example Model";
      owner = "vendor";
      limits = {
        context = 131072;
        output = 16384;
      };
      capabilities = {
        tool_call = true;
        reasoning = false;
        attachment = false;
        temperature = true;
      };
      modalities = {
        input = [ "text" ];
        output = [ "text" ];
      };
    };

    openCode = {
      enable = true;
      command = "opencode";
    };
  };
}
```

The remaining options mirror the standalone JSON fields:

| Home Manager option | Default | JSON field |
| --- | ---: | --- |
| `listenAddress` | `127.0.0.1:4000` | `listen` |
| `requestsPerMinute` | `32` | `rpm` |
| `maxInflight` | `3` | `max_inflight` |
| `queueLimit` | `128` | `queue_limit` |
| `maxQueuedBodyBytes` | `268435456` | `max_queued_body_bytes` |
| `maxRequestBodyBytes` | `16777216` | `max_request_body_bytes` |
| `maxRetries` | `12` | `max_retries` |
| `maxBackoff` | `300s` | `max_backoff` |
| `upstreamRequestTimeout` | `1800s` | `upstream_request_timeout` |
| `streamIdleTimeout` | `1800s` | `stream_idle_timeout` |
| `connectTimeout` | `30s` | `connect_timeout` |
| `minAdaptiveRequestsPerMinute` | `1` | `min_adaptive_rpm` |
| `fileDescriptorLimit` | `1024` | service-only |

`queueLimit` may not exceed 500. `fileDescriptorLimit` must be at least
`queueLimit + (2 * maxInflight) + 64`. Admission counts queued, active, and
retry-backoff requests; `requestsPerMinute` is a ceiling rather than a promise
of upstream capacity.

## Interactive startup and restart

Apply the Home Manager configuration through the consumer's normal activation
flow, then start the service interactively:

```bash
llm-pacer-start
```

The starter is the supported start path. It serializes concurrent starts,
checks the unit first, retrieves both values through `safe-op`, stages private
mode-0400 credential files below `$XDG_RUNTIME_DIR`, and asks the user systemd
manager to start the daemon. systemd copies the credentials before the starter
removes its source files.

The startup approval is intentionally interactive. The service has no
`WantedBy`, timer, automatic restart, or unattended 1Password lookup.

Check it without handling a secret:

```bash
systemctl --user is-active llm-pacer.service
curl --fail --silent --show-error http://127.0.0.1:4000/healthz
journalctl --user -u llm-pacer.service --since today
```

Running `llm-pacer-start` again while the unit is active is a successful no-op.
It checks active state before contacting 1Password and does not replace the
process. Therefore it is not a configuration-reload command.

If a unit newly attempted by the starter fails to become healthy, the starter
stops that attempted unit and removes staged credentials. This cleanup never
applies to a process that was already active when the starter began.

To apply changed configuration or rotated credentials, deliberately stop the
old process and perform another interactive start:

```bash
systemctl --user stop llm-pacer.service
llm-pacer-start
```

Do not use `systemctl --user restart llm-pacer.service` or start the unit
directly. The source credential files are deliberately ephemeral; only the
starter restages them. A deliberate stop creates downtime if the following
1Password approval or startup fails.

After successful startup, the daemon has already read both credentials and can
continue if the 1Password vault locks. Locking the vault does not rotate or
revoke an in-memory value. A crash remains stopped and requires another
interactive `llm-pacer-start`.

## OpenCode provider

With `services.llm-pacer.openCode.enable = true`, Home Manager installs:

- `~/.config/opencode/plugins/llm-pacer.js`; and
- the `llm-pacer-opencode` launcher.

Start the proxy first, then launch OpenCode through the wrapper:

```bash
llm-pacer-start
llm-pacer-opencode models llm-pacer
llm-pacer-opencode run --model llm-pacer/vendor/example-model "Your request"
```

The plugin registers provider `llm-pacer` with
`@ai-sdk/openai-compatible`. It disables OpenCode's request and response-header
timeouts so a queued request can remain connected; it does not synthesize
progress events while waiting. The plugin tries authenticated `/v1/models`
discovery and falls back to the static Home Manager catalog if the local daemon
is temporarily unavailable.

`llm-pacer-opencode` reads only the distinct local token from 1Password and
places it in `LLM_PACER_API_KEY` for the new OpenCode process. It never receives
the upstream credential. An already-running OpenCode process continues after
the vault locks; launching another process requires another successful
1Password read.

Other harnesses can use:

```text
Base URL: http://127.0.0.1:4000/v1
API key:  the distinct local token
Model:    one exact ID returned by GET /v1/models
```

Disable short client request/header timeouts. The inbound connection itself is
the version-one wait mechanism; there is no submit-and-poll job API.

## Protocol smoke examples

These commands intentionally use an obvious fake local token and are safe only
for a local mock configured with the same fake value. Never replace the token
literal with a real secret: command arguments can be exposed to process and
shell-history inspection.

```bash
curl --fail --silent --show-error \
  -H 'Authorization: Bearer local-EXAMPLE-NOT-A-SECRET' \
  http://127.0.0.1:4000/v1/models

curl --no-buffer --silent --show-error \
  -H 'Authorization: Bearer local-EXAMPLE-NOT-A-SECRET' \
  -H 'Content-Type: application/json' \
  --data '{"model":"acme/mock-model","messages":[{"role":"user","content":"mock request"}],"stream":true}' \
  http://127.0.0.1:4000/v1/chat/completions
```

For real OpenCode use, prefer `llm-pacer-opencode`; it avoids placing the local
token in argv or shell history.

## Mock-only verification

From the repository root, the Snowfall checks exercise the Go suite, generated
Home Manager unit/plugin, and interactive starter without contacting a provider:

```bash
nix build 'path:.#checks.x86_64-linux.llm-pacer' --no-link -L
nix build 'path:.#checks.x86_64-linux.llm-pacer-home-module' --no-link -L
nix build 'path:.#checks.x86_64-linux.llm-pacer-starter' --no-link -L
nix build 'path:.#llm-pacer' --no-link -L
nix flake check 'path:.' -L
```

The Home Manager check uses offline `systemd-analyze verify`; starter and
launcher lifecycle tests use local command mocks. Repository acceptance does
not activate the real user unit or ask 1Password for a value. Runtime activation
belongs to the consumer configuration after review.

The real OpenCode compatibility fixture still uses only in-process local mock
HTTP servers. It is opt-in because it requires the exact supported executable:

```bash
cd /home/xing/works/home/safe-cli/tools/llm-pacer
XDG_CACHE_HOME=/tmp/llm-pacer-nix-cache \
OPENCODE_BIN=/home/xing/.nix-profile/bin/opencode \
nix shell --impure \
  --expr '(builtins.getFlake (toString /home/xing/works/home/safe-cli)).inputs.nixpkgs.legacyPackages.x86_64-linux.go' \
  -c go test -v -count=1 -timeout=60s ./internal/opencode
```

With `OPENCODE_BIN` unset, that fixture skips cleanly so package builds remain
hermetic. It must never be pointed at a real provider.

The mock-only fifty-client acceptance can be repeated from the same nested Go
module shell:

```bash
go test -count=1 -timeout=45s \
  -run '^TestConcurrentRequestsStayConnectedAndArePaced$' -v \
  ./internal/daemon
```

It releases all clients together through the real daemon handler, records only
local mock-upstream start times and concurrency, and requires every inbound
connection to remain open through a successful response.

## Operational limitations

- Queue and adaptive state are process-local and in memory. A stop or crash
  drops waiting requests and resets adaptive pacing.
- There is no durable submit-and-poll API. Client task recovery remains the
  harness's responsibility.
- Version one limits request starts, not tokens per minute.
- One process supports one upstream URL, credential, and quota domain. The Home
  Manager module currently declares one fixed user-service instance.
- Upstream 429, 500, 502, 503, and 504 responses can be retried before any
  downstream response is committed. `Retry-After` is honored but capped by
  `maxBackoff`; every retry attempt is paced globally.
- Automatic transport retry is limited to explicitly classified transient dial
  failures that occur before the request is sent. Generic errors, TLS failures,
  response-header timeouts, body-read failures, and interrupted streams are not
  replayed. This avoids blindly duplicating a `POST` after an ambiguous failure.
- There is no automatic startup or crash restart. This is necessary to keep
  every new 1Password read interactive.
- The daemon deliberately retains credentials in process memory for its
  lifetime. The local token also remains in an already-running OpenCode
  environment. Vault locking does not revoke either value.
- The service is loopback-only and provides no TLS or remote-client boundary.
- The static OpenCode fallback reflects the catalog from the last Home Manager
  build; restart OpenCode after deploying catalog changes.
- `/healthz` is unauthenticated but exposes only aggregate state on loopback.

## Rollback

Runtime rollback is immediate and does not require 1Password:

```bash
systemctl --user stop llm-pacer.service
```

Then remove or disable `services.llm-pacer` in the consumer and run its normal
Home Manager activation. Stop the service before removing the unit because it
is intentionally not target-managed or automatically restarted.

For a source rollback, revert the relevant implementation or integration commit
instead of moving branch history. Preserve
`e40f7f6 docs(llm-pacer): record implementation plan` as the historical bottom
commit of the feature branch. Re-run all three focused checks and
`nix flake check` before updating a consumer lock.
