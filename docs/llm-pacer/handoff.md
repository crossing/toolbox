# llm-pacer implementation handoff

Updated: 2026-07-26

This is the durable resume and acceptance record. Operator configuration and
lifecycle instructions are in `docs/llm-pacer/operator-guide.md`. The original
approved contract is retained unchanged in `docs/llm-pacer/implementation-plan.md`.

## Repository state

- Repository: `/home/xing/works/home/safe-cli`
- Branch: `feature/llm-pacer`
- Snowfall base: `0a117d1 refactor: adopt Snowfall Lib layout`
- Required bottom feature commit:
  `e40f7f6 docs(llm-pacer): record implementation plan`
- Latest implementation commit:
  `0a8726f feat(llm-pacer): integrate Home Manager and OpenCode`
- Runtime activation, consumer configuration, push, and real-provider calls were
  intentionally not performed.

Do not rewrite or rebase the plan above later implementation commits. Verify
with `git log --reverse --oneline 0a117d1..HEAD`: `e40f7f6` must remain first.

## Commit ledger

```text
e40f7f6 docs(llm-pacer): record implementation plan
593fc4b feat(llm-pacer): establish local provider contract
7c8d817 feat(llm-pacer): add retry and credential primitives
1c5df18 feat(llm-pacer): enforce paced request scheduling
ba69b72 feat(llm-pacer): proxy paced OpenAI requests
f073266 fix(llm-pacer): harden proxy boundaries
0a8726f feat(llm-pacer): integrate Home Manager and OpenCode
```

The documentation-finalization commit containing this handoff follows the
ledger above. Its hash is intentionally obtained from `git log -1`; embedding a
commit's own hash in its contents is not stable.

## Delivered contract

- Generic `llm-pacer` name; NVIDIA NIM is only the first intended upstream.
- Isolated Go module at `tools/llm-pacer/go.mod`; no root Go dependency changes
  and no `go.work` or third-party Go dependencies.
- Direct standard-library `net/http` transport. Bifrost Core `core/v1.5.13`
  failed the fit gate because its fasthttp path did not provide reliable
  underlying-request cancellation and could retry a stale connection outside
  the pacer.
- One process per upstream URL, credential, and quota domain.
- Strict non-secret JSON configuration and authoritative model allowlist.
- Loopback OpenAI-compatible provider with authenticated `GET /v1/models`,
  `GET /v1/models/{id}`, and offline `export-models` in OpenAI and OpenCode
  formats.
- Bounded count/byte admission. Admitted connections stay open in FIFO order;
  overflow is a local 429 with `Retry-After`, `retry-after-ms`, and
  `proxy_queue_full`.
- Admission occurs before upload reading. Unknown-length uploads reserve the
  full per-request allowance, so slow uploads remain inside admission bounds.
- Globally spaced request starts, separate upstream concurrency, paced retries,
  capped `Retry-After`, exponential jitter, adaptive 429 slowdown/recovery,
  JSON/SSE forwarding, and disconnect cancellation.
- Retries for upstream 429, 500, 502, 503, and 504. Automatic transport retry is
  limited to classified transient pre-request dial failures. Ambiguous POST,
  TLS, response-header, response-body, and interrupted-stream failures are not
  replayed.
- Fail-closed forwarding: only model-bearing POST inference crosses the proxy.
  Management namespaces, missing/duplicate/disallowed models, opaque or encoded
  bodies, encoded paths, repeated slashes, dot segments, and backslashes fail
  locally. This stricter policy supersedes the historical plan's broader route
  and safe-response-read-retry assumptions; the historical commit is preserved
  as the original decision record.
- Structured logs contain request IDs, routes, model IDs, attempt/status/timing,
  and aggregate scheduler state, never credentials, prompts, or response bodies.

## Home Manager and secret lifecycle

- Snowfall exports `packages.llm-pacer`, the public overlay entry, the toolbox
  skill, checks, and `homeModules.llm-pacer`.
- The module export wraps the raw Home Manager module and injects only
  `llm-pacer` and `safe-op`; it does not expose Snowfall's private
  `toolbox-internal` package namespace or a public `self.pkgs` output.
- `services.llm-pacer` renders the non-secret config, hardened systemd user unit,
  interactive starter, OpenCode plugin, and secret-safe OpenCode launcher.
- The unit has no `Install`/`WantedBy`, no automatic restart, `LimitCORE=0`, and
  `X-SwitchMethod=keep-old` so Home Manager activation preserves a live process.
- `llm-pacer-start` locks concurrent starts and checks active state before any
  1Password access. Re-running it for an active unit is a successful no-op and
  cannot replace the process. A newly attempted but unhealthy unit is stopped.
- On a real start, `safe-op` output travels only through pipes into mode-0400
  systemd credential staging. No credential enters argv, generated Nix, a shell
  variable, stdout, logs, or the Nix store.
- The daemon reads both credentials once; only the distinct local token reaches
  OpenCode. Running daemon/OpenCode processes continue after the vault locks.
  Every new daemon start or OpenCode launch remains intentionally interactive.

## OpenCode provider

- The plugin registers provider `llm-pacer` through
  `@ai-sdk/openai-compatible` with loopback `/v1` base URL.
- Its asynchronous config hook performs authenticated live model discovery and
  falls back to the generated static catalog when the daemon is unavailable.
- It declares only `env: ["LLM_PACER_API_KEY"]`; the token is not placed in
  provider options because `opencode debug config` renders resolved options.
- `headerTimeout: false` and `timeout: false` let a queued request keep its
  inbound connection open without synthetic progress events.
- `llm-pacer-opencode` reads only the local token from 1Password and uses
  `exec-with-local-token` to place it solely in the child environment while
  preserving arguments and exit status.

There is no universal provider-registration interface across agent harnesses.
The reusable wire-level discovery contract is the OpenAI Models API; harnesses
still register a custom OpenAI-compatible provider according to their own
configuration model.

## Acceptance evidence

All HTTP/provider fixtures were local mocks. No provider key, paid endpoint,
real prompt, provider response, or live 1Password item was used.

| Gate | Final evidence on 2026-07-26 |
| --- | --- |
| Go suite | From `tools/llm-pacer`: `go test -count=1 -timeout=90s ./...` passed every package |
| Race suite | `go test -race -count=1 -timeout=120s ./...` passed every package |
| Static analysis | `go vet ./...` passed |
| Real OpenCode 1.18.5 | Opt-in local-mock acceptance passed in 5.33s normal and 6.35s race; discovery, model selection, static fallback, auth replacement, exact SSE completion, timeout config, and token non-exposure were checked |
| Queued OpenCode behavior | The real OpenCode request stayed connected with no downstream header and no command exit during a controlled 2.5s silent queue wait, then completed after the occupied upstream slot was released |
| Fifty-client load | The local mock fixture released 50 clients together, kept all admitted connections alive, enforced aggregate start spacing, observed overlap without exceeding `max_inflight=3`, and returned 50 HTTP 200 responses; a focused `-count=10` run also passed |
| Package and overlay | `packages.llm-pacer` built through the public overlay and ran the nested mock-only Go suite |
| Home Manager | Module evaluation, offline `systemd-analyze verify --user`, plugin syntax, no public `self.pkgs`, no `Install`, `Restart=no`, `LimitCORE=0`, `X-SwitchMethod=keep-old`, and invalid 1Password-ref rejection passed |
| Launch helpers | Mock lifecycle tests passed active no-op, process preservation, private staging, unhealthy cleanup, vault failure, pipe-only reads, local-token-only OpenCode injection, argument preservation, child status propagation, and output/argv non-exposure |
| Repository gate | `nix flake check 'path:.' -L` passed all 10 x86_64-linux checks, including shellcheck and `no-ignored-tool-files`; other declared systems were not executed on this host |
| Boundary audit | `git diff --check` passed; no root `go.mod`/`go.sum` changes, no `go.work*`, and no credential-like high-risk patterns were found |

The systemd validation is intentionally offline and the lifecycle checks use
command mocks. A real user-manager activation is the consumer deployment step,
not repository acceptance.

## Safety and rollback

- Never point repository tests at a real provider.
- Never print or commit credentials, private 1Password references, prompts,
  responses, or private provider/model data.
- Use `llm-pacer-start`; never start or restart the unit directly because the
  source credential files are intentionally ephemeral.
- A deliberate credential/config change is:
  `systemctl --user stop llm-pacer.service`, followed by a new interactive
  `llm-pacer-start`. This creates downtime if approval or startup fails.
- Immediate runtime rollback is `systemctl --user stop llm-pacer.service`, then
  disable the Home Manager option in the consumer.
- Revert later implementation commits if source rollback is needed; preserve
  the historical bottom plan commit.

No implementation work remains in this repository. Consumer enablement and a
mock-first or deliberately authorized real runtime smoke test are separate
follow-up actions.
