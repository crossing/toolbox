---
name: safe-op
description: Read 1Password secrets without leaking them into the transcript. Use instead of `op` for any command that touches a credential.
---

# safe-op

A wrapper around the 1Password CLI that **blocks** any invocation which would render a
secret to a terminal, while allowing the identical call through command substitution or
a pipe.

## Why this exists

An agent that runs `op item get x --field password` puts the secret in its own
transcript, where it persists in logs, context, and any downstream summary. `safe-op`
makes that specific mistake impossible without getting in the way of legitimate use.

## Usage

Always capture into a variable or pipe. Never let output reach the terminal:

```bash
TOKEN=$(safe-op item get my-item --field credential)   # allowed
safe-op item get my-item --field credential | some-tool  # allowed
safe-op item get my-item --field credential              # BLOCKED
```

Non-secret reads are unrestricted:

```bash
safe-op item get my-item --field username    # allowed, not a secret field
safe-op item list                            # allowed
safe-op item get my-item                     # allowed, values are masked
```

## What counts as a secret

A call is blocked when output is a terminal **and** any of:

- the subcommand is `read` or `document`
- `--reveal` or `--no-masking` is present
- a `--field`/`-f` value contains `password`, `secret`, `token`, `key`, `credential`,
  `private`, `api`, or `auth` (case-insensitive)

## If you hit the block

The error is telling you the call was correct but the *destination* was wrong. Re-run it
inside `$(...)` or through a pipe. Do not work around it with `op` directly, and never
echo, `cat`, or print the captured value afterwards.

## Limits worth knowing

- `op item get --format json` returns concealed values in plaintext and does **not**
  trip these checks. The guard is a strong default, not a hard security boundary.
- It only applies when `safe-op` is the binary actually invoked. Calling `op` directly
  bypasses it entirely.
- `op` itself is resolved from the ambient PATH, not pinned by nix, so the 1Password
  desktop app's wrapper is the one used.
