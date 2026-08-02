#!/usr/bin/env bash

# patch-gws-skills: convert the generated gws agent skills to op-gws, idempotently.
#
# Usage: patch-gws-skills [skills-dir]     (default: ~/.agents/skills)
#
# `gws generate-skills` writes skills that document bare `gws`, which has no
# credentials in an op-gws setup. This rewrites each gws-*/SKILL.md to call op-gws
# and inserts an Accounts section pointing at `op-gws --accounts` for runtime
# account discovery. Already-patched files are skipped, so re-running after every
# skill regeneration is safe and expected.

set -euo pipefail

SKILLS_DIR="${1:-$HOME/.agents/skills}"
if [[ ! -d "$SKILLS_DIR" ]]; then
    echo "Error: skills directory not found: $SKILLS_DIR" >&2
    exit 3
fi

section_file=$(mktemp)
trap 'rm -f "$section_file"' EXIT
cat > "$section_file" <<'SECTION'

## Accounts

Multiple Google accounts may be configured. Run `op-gws --accounts` to list them —
each entry has a name, a free-text note about what the account is for, and a default
marker. Pass the account name as the first argument (`op-gws <account> ...`);
omitting it uses the default account.
SECTION

patched=0
skipped=0
shopt -s nullglob
for skill in "$SKILLS_DIR"/gws-*/SKILL.md; do
    if grep -q "op-gws --accounts" "$skill"; then
        echo "skip (already patched): $skill" >&2
        skipped=$((skipped + 1))
        continue
    fi

    tmp=$(mktemp)
    # Rewrite `gws ` command references without touching hyphenated names or paths
    # like ../gws-gmail-send/; also the bare `- gws` requires.bins frontmatter entry.
    # Then insert the Accounts section right after the first H1 heading.
    sed -E \
        -e 's#(^|[^-A-Za-z0-9_./])gws #\1op-gws #g' \
        -e 's#^( *- )gws$#\1op-gws#' \
        "$skill" \
        | awk -v secfile="$section_file" \
            '{print} !done && /^# /{while ((getline line < secfile) > 0) print line; done=1}' \
        > "$tmp"

    if ! grep -q "op-gws --accounts" "$tmp"; then
        # No H1 heading to anchor on; append the section instead.
        cat "$section_file" >> "$tmp"
    fi

    mv "$tmp" "$skill"
    echo "patched: $skill" >&2
    patched=$((patched + 1))
done

echo "{\"patched\":$patched,\"skipped\":$skipped}"
