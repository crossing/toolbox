# Adding a tool

Five steps. If you find yourself doing a sixth, the structure is wrong — fix the
structure rather than working around it.

## 1. Create the directory

```
tools/<name>/
├── package.nix        # derivation, takes explicit args (no `pkgs`, no `inputs`)
├── <name>.sh          # or main.go, or whatever the tool is
├── SKILL.md           # how an agent should use it
└── tests/
    └── test-<name>.sh
```

The **binary name, the directory name, and the SKILL.md `name:` must all match.** No
exceptions — this is what lets a reader go from a command they saw in a transcript to
its source without searching.

## 2. Write `package.nix`

Take explicit arguments, never `pkgs` wholesale:

```nix
{ lib, writeShellApplication, coreutils, jq }:
writeShellApplication {
  name = "<name>";
  runtimeInputs = [ coreutils jq ];
  text = builtins.readFile ./<name>.sh;
  meta = {
    description = "...";
    mainProgram = "<name>";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;   # or lib.platforms.linux
  };
}
```

`writeShellApplication` runs shellcheck at build time and sets `set -euo pipefail`, so
a script that passes standalone can still fail when packaged. Watch for pipelines whose
failure you were relying on being ignored — see the `|| true` in `tools/safe-op/safe-op.sh`.

**Every external command must be in `runtimeInputs`**, with one deliberate exception:
tools that must reach the 1Password setuid wrapper leave `op` out on purpose, because
pinning it would shadow `/run/wrappers/bin/op`. Document any such exception in the file.

## 3. Make tests location-independent

Tests run both from a checkout and from a read-only nix store path. Start every test
with:

```bash
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
```

Then:

- Never `chmod` the source — under nix it is read-only and the test will die.
- Invoke scripts as `bash "$tool_dir/<name>.sh"`, so no exec bit is required.
- Give generated mock binaries a resolvable shebang: `#!$(command -v bash)`. There is
  no `/usr/bin/env` in the build sandbox.

## 4. Register it

In `flake.nix`, add one line to `overlays.default`, one to the `packages` inherit, and
an entry to `toolbox-skills`. In `nix/checks.nix`, add a `mkToolTest` block.

For a Linux-only tool, add it under the `linuxSystems` branch instead so `nix flake
check` still passes on darwin.

## 5. Verify

```bash
nix flake check
nix build .#<name>
```

`nix flake check` is the gate: it runs the tests, shellchecks everything under `tools/`,
and fails if any path under `tools/` has become gitignored.
