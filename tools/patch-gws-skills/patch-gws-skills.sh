#!/usr/bin/env bash

# patch-gws-skills: convert the generated gws agent skills to op-gws, idempotently.
#
# Usage: patch-gws-skills [skills-dir]     (default: ~/.agents/skills)
#
# `gws generate-skills` writes skills that document bare `gws`, which has no
# credentials in an op-gws setup. This rewrites each gws-*/SKILL.md to call op-gws,
# inserts an Accounts section pointing at `op-gws --accounts` for runtime account
# discovery, and inserts a note preferring the op-mcp MCP tool for reads when the
# service is running. Each insertion is keyed on its own marker, so re-running
# after every skill regeneration is safe and expected, and skills patched before
# the op-mcp note existed pick it up on the next run.

set -euo pipefail

SKILLS_DIR="${1:-$HOME/.agents/skills}"
if [[ ! -d "$SKILLS_DIR" ]]; then
    echo "Error: skills directory not found: $SKILLS_DIR" >&2
    exit 3
fi

accounts_file=$(mktemp)
mcp_file=$(mktemp)
trap 'rm -f "$accounts_file" "$mcp_file"' EXIT
cat > "$accounts_file" <<'SECTION'

## Accounts

Multiple Google accounts may be configured. Run `op-gws --accounts` to list them —
each entry has a name, a free-text note about what the account is for, and a default
marker. Pass the account name as the first argument (`op-gws <account> ...`);
omitting it uses the default account.
SECTION
cat > "$mcp_file" <<'SECTION'

## Prefer op-mcp for reads

When the op-mcp MCP tools are available in your session, use its `gws` tool for
read operations instead of the op-gws CLI — the running service holds tokens in
memory, so reads need no 1Password authorization. Fall back to op-gws when the
service is not running. Writes through op-mcp become plans a human reviews and
runs in a terminal; never attempt to execute a plan yourself.
SECTION

# Insert a section right after the first H1 heading (appended when there is none),
# unless the file already carries the marker.
insert_section() {
    local skill=$1 section=$2 marker=$3 tmp
    grep -q "$marker" "$skill" && return 1
    tmp=$(mktemp)
    awk -v secfile="$section" \
        '{print} !done && /^# /{while ((getline line < secfile) > 0) print line; done=1}' \
        "$skill" > "$tmp"
    if ! grep -q "$marker" "$tmp"; then
        cat "$section" >> "$tmp"
    fi
    mv "$tmp" "$skill"
    return 0
}

patched=0
skipped=0
shopt -s nullglob
for skill in "$SKILLS_DIR"/gws-*/SKILL.md; do
    changed=0

    if ! grep -q "op-gws --accounts" "$skill"; then
        tmp=$(mktemp)
        # Rewrite `gws ` command references without touching hyphenated names or
        # paths like ../gws-gmail-send/; also the bare `- gws` requires.bins
        # frontmatter entry.
        sed -E \
            -e 's#(^|[^-A-Za-z0-9_./])gws #\1op-gws #g' \
            -e 's#^( *- )gws$#\1op-gws#' \
            "$skill" > "$tmp"
        mv "$tmp" "$skill"
        insert_section "$skill" "$accounts_file" "op-gws --accounts" || true
        changed=1
    fi

    if insert_section "$skill" "$mcp_file" "op-mcp"; then
        changed=1
    fi

    if [[ "$changed" -eq 1 ]]; then
        echo "patched: $skill" >&2
        patched=$((patched + 1))
    else
        echo "skip (already patched): $skill" >&2
        skipped=$((skipped + 1))
    fi
done

echo "{\"patched\":$patched,\"skipped\":$skipped}"
