# Conventions

These tools are consumed by AI agents first and humans second. That inverts a few
defaults.

## Output

**JSON on stdout by default. `--human` pretty-prints.** Not the other way round — the
common caller is a program, so machine-readable is the unmarked case and prettiness is
the opt-in.

```
$ freeagent bills list            # compact JSON
$ freeagent bills list --human    # indented JSON
```

Note what `--human` does *not* mean: it is not a table, not prose. An agent that
accidentally passes it still gets parseable output.

**stdout carries data; stderr carries everything else.** Progress, warnings, and
prompts go to stderr so `$(...)` stays clean. `tools/op-oauth2c` is the reference here.

## Errors

Structured, and on stderr. Where a tool wraps an API, surface the upstream shape rather
than flattening it to a string:

```go
type APIError struct {
    StatusCode int
    Message    string
    Errors     map[string]interface{}
}
```

Exit non-zero on failure, and document what each code means in the tool's SKILL.md.
An agent cannot recover from a failure it cannot distinguish from success.

## Secrets

Never print a credential to stdout where it can land in a transcript. `safe-op` exists
because that failure is otherwise silent and permanent — a leaked secret in a context
window has already been logged.

When a tool needs a secret:

- read it from 1Password at the point of use, not from a file
- use command substitution, never a bare invocation
- never echo it back, even for confirmation

## Skills

One `SKILL.md` per tool, in the tool's own directory. It ships with the code, so it
cannot drift. `packages/toolbox-skills/default.nix` collects them into a
`toolbox-skills` package.

Write it for an agent deciding *whether* to reach for the tool, not just how to call it.
State what it is for, what it refuses to do, and what its limits are. `tools/safe-op/SKILL.md`
documents its own bypasses — a skill that oversells its guarantees is worse than none.

## Naming

Binary name == directory name == SKILL.md `name:`. Package-specific dependency manifests
and lockfiles live under `tools/<name>/`; for example, a Go tool keeps `go.mod` and
`go.sum` beside its source and builds its module root with `subPackages = [ "." ]`.

## Verifying the sops recovery key

`age` and `sops` are in the devShell for this. Re-run after every `sops updatekeys` —
re-keying is exactly when a recovery recipient gets silently dropped:

```bash
key="$(op read 'op://Op/sops-age-key-recovery/password')"
age-keygen -y <<< "$key"        # must equal the `recover` recipient in home-ops/.sops.yaml
unset key
```
