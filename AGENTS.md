# toolbox

Agent-facing command-line tools. One repo so that a tool, its tests, and the skill that
teaches an agent to use it live together and cannot drift apart.

## Layout

```
tools/<name>/       one directory per tool: package.nix, dependencies, source, SKILL.md, tests/
packages/<name>/    Snowfall package entrypoints; thin wrappers around tools/<name>/
checks/<name>/      Snowfall-discovered checks, one output per directory
shells/<name>/      Snowfall-discovered development shells
docs/               conventions.md, adding-a-tool.md
```

Tool-first, not language-first. `ibkr-local` is bash + a uv2nix Python dependency + a
podman runtime; it has no home in a `sh/` directory. The question people actually ask is
"show me everything about tool X", and this layout answers it. Snowfall entrypoints stay
thin so the implementation, derivation, tests, and skill remain together under `tools/`.
Package-specific dependency manifests and lockfiles belong there too, never at the
repository root.

## Rules

- **Read `docs/adding-a-tool.md` before adding a tool.** It is a five-step checklist.
- **Use Snowfall discovery.** Add package, check, and shell outputs under their
  conventional directories; do not hand-wire per-system output sets in `flake.nix`.
- **`nix flake check` is the gate.** It runs every tool's tests, shellchecks everything
  under `tools/`, and fails if any path under `tools/` becomes gitignored.
- **Never use bare, unanchored patterns in `.gitignore`.** This already cost a file:
  freeagent-cli's `.gitignore` line 1 was `freeagent-cli`, which silently ignored
  `.agents/skills/freeagent-cli/SKILL.md` — the commit claiming to add it added nothing.
  Anchor with a leading `/`.
- **Never `git add -f`.** If a file is ignored, the ignore rule is wrong.
- **Longer work happens in a worktree.** Several agent sessions share this checkout;
  never switch its branch for multi-step work. `git worktree add
  ../toolbox-wt-<topic> -b <branch> origin/master`, work there, and
  `git worktree remove` it once the branch has merged.
- **This repo is public.** It must never contain account numbers, portfolio values,
  holdings, or anything else identifying real financial positions. Test fixtures use
  obviously-fake identifiers (`U00000001`…). Check before committing anything copied out
  of a private repo.

## Consumers

`home-ops` takes this flake as an input and installs from it. Two things there are
load-bearing:

- `packages.<system>.safe-op` and `.op-oauth2c` keep those exact attribute paths.
- `overlays.default` is the preferred interface, matching how home-ops surfaces its
  other flake inputs.

The public outputs are deliberately kept flat even though sibling packages resolve
through the internal `toolbox-internal` namespace. Do not expose the namespace or
Snowfall's generated per-package overlays without coordinating the consumer migration
first.

home-ops runs an unattended weekly `nix flake update`, so a broken push here can reach a
machine with no human in the loop. Keep the input list minimal and `nix flake check`
green.

## Conventions

See `docs/conventions.md`. In short: JSON on stdout by default, `--human` to indent,
diagnostics to stderr, structured errors, never print a secret.
