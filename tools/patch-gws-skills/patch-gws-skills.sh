#!/usr/bin/env bash

# patch-gws-skills: convert the generated gws agent skills to op-gws, idempotently.
#
# Usage: patch-gws-skills [skills-dir]     (default: ~/.agents/skills)
#
# `gws generate-skills` writes skills that document bare `gws`, which has no
# credentials in an op-gws setup. This rewrites each gws-*/SKILL.md to call op-gws,
# inserts an Accounts section pointing at `op-gws --accounts` for runtime account
# discovery, and inserts a note steering the agent at the hosted MCP gateway first —
# worded per service, because the gateway carries Gmail and Drive but nothing else.
# Each insertion is keyed on its own marker, so re-running after every skill
# regeneration is safe and expected. Skills still carrying the retired op-mcp note
# have it stripped and replaced on the next run.

set -euo pipefail

SKILLS_DIR="${1:-$HOME/.agents/skills}"
if [[ ! -d "$SKILLS_DIR" ]]; then
    echo "Error: skills directory not found: $SKILLS_DIR" >&2
    exit 3
fi

GATEWAY_MARKER="mcp.xing.works"

accounts_file=$(mktemp)
gateway_file=$(mktemp)
trap 'rm -f "$accounts_file" "$gateway_file"' EXIT
cat > "$accounts_file" <<'SECTION'

## Accounts

Multiple Google accounts may be configured. Run `op-gws --accounts` to list them —
each entry has a name, a free-text note about what the account is for, and a default
marker. Pass the account name as the first argument (`op-gws <account> ...`);
omitting it uses the default account.
SECTION

# The gateway note, written per service into $gateway_file. Gmail and Drive have
# gateway tools and a specific fallback list; every other service has none.
write_gateway_section() {
    local service=$1
    case "$service" in
        gmail)
            cat > "$gateway_file" <<'SECTION'

## Prefer the MCP gateway

The hosted MCP gateway (connector "Gateway", `https://mcp.xing.works/mcp`) is the
first choice for Gmail. Its `gmail_*` tools hold their own Google tokens, so they
cost no 1Password authorization, and reads and writes both execute directly:
search, get message, get thread, list/create/update/delete labels, modify labels,
list and create drafts (including in-thread replies and Drive attachments),
list/create/delete filters, and get attachment. Every tool takes an optional
`account` — `gateway_list_accounts` names the linked ones.

Use this CLI for the rest: sending mail (the gateway only drafts), trashing or
deleting messages, thread-level modification, settings (send-as, forwarding,
vacation), and `history`/`watch`.
SECTION
            ;;
        drive)
            cat > "$gateway_file" <<'SECTION'

## Prefer the MCP gateway

The hosted MCP gateway (connector "Gateway", `https://mcp.xing.works/mcp`) is the
first choice for Drive. Its `drive_*` tools hold their own Google tokens, so they
cost no 1Password authorization, and reads and writes both execute directly:
search, get metadata, read (exporting to text, markdown, pdf, docx, xlsx, pptx,
csv or html), create files and folders from text or base64, update (rename, move,
replace content), trash, and the cross-account relays
`drive_save_gmail_attachment` and `drive_save_whatsapp_media`. Every tool takes an
optional `account` — `gateway_list_accounts` names the linked ones.

Use this CLI for the rest: permissions and sharing, revisions, copy, shared-drive
administration, and anything needing raw API parameters.
SECTION
            ;;
        shared)
            cat > "$gateway_file" <<'SECTION'

## Prefer the MCP gateway

The hosted MCP gateway (connector "Gateway", `https://mcp.xing.works/mcp`) is the
first choice for Gmail and Drive: its `gmail_*` and `drive_*` tools hold their own
Google tokens, so they cost no 1Password authorization, and both reads and writes
execute directly. It carries no other Workspace service — calendar, docs, sheets,
slides, keep, tasks, people, chat, forms, meet and admin-reports are op-gws only,
as is raw API access (`op-gws schema`, `--page-all`, unusual parameters).
SECTION
            ;;
        *)
            cat > "$gateway_file" <<'SECTION'

## No MCP gateway tools for this service

The hosted MCP gateway (`https://mcp.xing.works/mcp`) carries Gmail, Drive,
FreeAgent and WhatsApp only. This service has none of its tools, so this CLI is
the only path to it — expect one 1Password authorization per invocation.
SECTION
            ;;
    esac
    cat >> "$gateway_file" <<'SECTION'

Gateway capability gaps are tracked in beads under the `work-ysf` epic. When a
task falls back to this CLI because the gateway has no tool for it, check
`bd show work-ysf` and, if the gap is not already a child, log it once the task
is done — never interrupt the task to file it:

```bash
bd create "gateway: <what is missing>" --parent work-ysf -p 2 -l gateway,mcp \
  -d "<the task, and the CLI command used instead>"
```
SECTION
}

# Drop the retired op-mcp note: from its heading up to (not including) the next
# `## ` heading. Returns 0 when the file changed.
strip_op_mcp_section() {
    local skill=$1 tmp
    grep -q '^## Prefer op-mcp for reads' "$skill" || return 1
    tmp=$(mktemp)
    awk '/^## Prefer op-mcp for reads/{drop=1; next} drop && /^## /{drop=0} !drop{print}' \
        "$skill" > "$tmp"
    mv "$tmp" "$skill"
    return 0
}

# Insert a section right after the first H1 heading (appended when there is none),
# unless the file already carries the marker.
insert_section() {
    local skill=$1 section=$2 marker=$3 tmp
    grep -q -- "$marker" "$skill" && return 1
    tmp=$(mktemp)
    awk -v secfile="$section" \
        '{print} !done && /^# /{while ((getline line < secfile) > 0) print line; done=1}' \
        "$skill" > "$tmp"
    if ! grep -q -- "$marker" "$tmp"; then
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

    if strip_op_mcp_section "$skill"; then
        changed=1
    fi

    # Service name from the directory: gws-gmail-send -> gmail, gws-docs -> docs.
    dir=$(basename "$(dirname "$skill")")
    service=${dir#gws-}
    service=${service%%-*}
    write_gateway_section "$service"

    if insert_section "$skill" "$gateway_file" "$GATEWAY_MARKER"; then
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
