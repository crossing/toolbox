---
name: patch-gws-skills
description: Rewrite the generated gws agent skills to use op-gws and advertise multi-account support. Run after every `gws generate-skills`.
---

# patch-gws-skills

`gws generate-skills` writes agent skills that document bare `gws`, which has no
credentials in an op-gws setup. This tool idempotently converts them.

## Usage

```bash
patch-gws-skills                 # patches ~/.agents/skills
patch-gws-skills /path/to/skills
```

Prints `{"patched":N,"skipped":M}` on stdout; per-file detail on stderr.

## What it does

For every `gws-*/SKILL.md` under the directory:

1. Rewrites `gws ` command references to `op-gws ` (word-anchored — hyphenated skill
   names and `../gws-*/` links are untouched), including the `- gws` requires.bins
   frontmatter entry.
2. Inserts an `## Accounts` section after the title telling agents to discover
   accounts with `op-gws --accounts` and select one via the first argument.
3. Skips files that already mention `op-gws --accounts`, so re-running after a skill
   regeneration only touches the freshly generated files.

## When to run

- After `gws generate-skills` (a gws upgrade regenerates the skills as bare-gws).
- After adding a new gws service skill.

## Exit codes

- `3` — skills directory not found
- `0` — otherwise; check the JSON counts
