---
name: patch-gws-skills
description: Rewrite the generated gws agent skills to use op-gws, advertise multi-account support, and steer at the MCP gateway first. Run after every `gws generate-skills`.
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
3. Inserts a gateway note after the title, worded from the skill's service:
   - `gws-gmail*` and `gws-drive*` get **Prefer the MCP gateway**, naming the
     `gmail_*` / `drive_*` tools and listing what still needs the CLI.
   - `gws-shared` gets the same note in general terms.
   - every other service gets **No MCP gateway tools for this service**, because
     the gateway carries Gmail, Drive, FreeAgent and WhatsApp only.
   Each variant ends with instructions for logging a capability gap as a child of
   the `work-ysf` beads epic.
4. Strips the retired `## Prefer op-mcp for reads` note from skills patched under
   the old scheme, replacing it with the gateway note.

Steps 1, 3 and 4 are keyed on separate markers, so re-running after a skill
regeneration only touches what is actually stale.

## When to run

- After `gws generate-skills` (a gws upgrade regenerates the skills as bare-gws).
- After adding a new gws service skill.
- After the gateway gains or loses tools, so the fallback lists stay true.

## Exit codes

- `3` — skills directory not found
- `0` — otherwise; check the JSON counts
