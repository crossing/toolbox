# llm-pacer live handoff

Updated: 2026-07-26

## Resume point

- Repository: `/home/xing/works/home/safe-cli`
- Branch: `feature/llm-pacer`
- Base: `master` at `2cf6400`
- Plan/bottom commit: `f983b3d docs(llm-pacer): record implementation plan`
- Working tree: tested config, scheduler, and upstream packages awaiting the
  next implementation checkpoint commit
- Full contract: `docs/llm-pacer/implementation-plan.md`

Do not rebase the plan above later commits: the user explicitly requires it to
remain the bottom commit on the implementation branch.

## Verified decisions

- Generic product name is `llm-pacer`; NVIDIA NIM is only the first upstream.
- Keep the tool in its own Go module and leave the root Go dependency graph
  untouched.
- The Bifrost Core fit gate failed. The latest tag compatible with repository Go
  1.26.2 is `core/v1.5.13`, but its fasthttp request path cannot reliably cancel
  the underlying request and includes a hidden stale-connection retry outside
  the global pacer. Use a direct `net/http` transport so every attempt and
  cancellation is controlled by `llm-pacer`.
- OpenCode 1.18.5 needs an asynchronous plugin `config` hook for a new local
  provider; its provider-model hook skips provider IDs absent from models.dev.
- The plugin must declare `env: ["LLM_PACER_API_KEY"]` instead of placing the
  token in provider `options.apiKey`: `opencode debug config` renders resolved
  options, while OpenCode converts the declared environment variable into the
  SDK key only when constructing the provider. The plugin may read the variable
  directly only for its authenticated local model-discovery request.
- OpenCode model limits are valid only when both context and output values are
  present. Restrict modalities to OpenCode's accepted text/audio/image/video/pdf
  values, and default absent custom-provider capabilities conservatively to
  false rather than letting tool-call support be overclaimed.
- Package and Home Manager export work waits for the concurrent Snowfall Lib
  layout to stabilize. That refactor is now committed as `0a117d1`; rebase onto
  it after the current core checkpoint, then add integration against its
  discovered package/check/module layout.
- The user unit will use absolute `%t/llm-pacer/credentials/...` sources with
  `LoadCredential=`, pass only `%d/...` file paths to the daemon, set
  `X-SwitchMethod=keep-old`, omit activation and restart directives, and clean
  staged sources only after systemd has copied them. The starter preserves the
  ambient `XDG_RUNTIME_DIR`, serializes with `flock`, and checks active state
  before any `safe-op` read.

## Evidence so far

```text
git log --oneline master..HEAD
f983b3d docs(llm-pacer): record implementation plan

catalog unit test (before branch creation)
ok github.com/crossing/toolbox/tools/llm-pacer/internal/catalog 0.002s

catalog plus HTTP API after OpenCode contract tightening
ok github.com/crossing/toolbox/tools/llm-pacer/internal/catalog 0.002s
ok github.com/crossing/toolbox/tools/llm-pacer/internal/httpapi 0.003s

focused retry policy
ok github.com/crossing/toolbox/tools/llm-pacer/internal/retry 0.002s

focused credential I/O
ok github.com/crossing/toolbox/tools/llm-pacer/internal/credential 0.003s

full nested module after config, scheduler minimum-RPM cap, and net/http adapter
ok all seven packages (go test -count=1 -timeout=30s ./...)

full nested module race run
ok all seven packages (go test -race -count=1 -timeout=60s ./...)
```

The upstream adapter initially appeared to hang because two delayed-header mock
handlers did no I/O and therefore did not promptly observe client connection
closure through `request.Context()`. Client-side response-header timeout and
explicit cancellation already returned correctly. The tests now assert those
observable contracts and release the handlers deterministically; focused and
race suites pass. No production timeout or assertion was weakened.

The test used the repository-locked Nix Go 1.26.2 shell. Host `go` is not on
`PATH`; use a task-specific writable Nix cache below `/tmp`.

## Next actions

1. Commit the validated configuration, scheduler, and upstream packages.
2. Rebase onto Snowfall commit `0a117d1`, preserving the plan as the first
   llm-pacer commit.
3. Integrate admission, retry, model validation, JSON, and SSE forwarding.
4. Add the CLI/server and credential-file-only startup path.
5. Add OpenCode provider discovery and hermetic 1.18.5 acceptance.
6. Add Snowfall package, check, and Home Manager exports.
7. Update this file after each verified phase and include it in phase commits.

## Safety boundaries

- Never call a real LLM provider from tests.
- Never print or commit credentials, prompts, responses, or real private data.
- Do not put secrets in argv, shell variables, environment declarations, logs,
  Home Manager/Nix values, or the Nix store.
- Do not edit the root `go.mod` or create a root `go.work`.
- Preserve concurrent Snowfall work and unrelated user changes.
