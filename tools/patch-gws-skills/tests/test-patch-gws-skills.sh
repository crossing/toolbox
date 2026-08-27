#!/usr/bin/env bash

# Unit tests for patch-gws-skills

set -e

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
PATCH="$tool_dir/patch-gws-skills.sh"
[ -f "$PATCH" ] || { echo "cannot find patch-gws-skills.sh at $PATCH"; exit 1; }

fail() {
    echo "  Failure: $1"
    echo "  --- skill file ---"
    cat "$TEST_DIR/skills/gws-fake/SKILL.md" 2>/dev/null || true
    exit 1
}

# Fixture mimicking the layout `gws generate-skills` produces.
mkdir -p "$TEST_DIR/skills/gws-fake" "$TEST_DIR/skills/other-skill"
cat > "$TEST_DIR/skills/gws-fake/SKILL.md" <<'EOF'
---
name: gws-fake
description: "Fake: test service."
metadata:
  version: 0.22.5
  openclaw:
    requires:
      bins:
        - gws
    cliHelp: "gws fake --help"
---

# fake (v1)

> **PREREQUISITE:** Read `../gws-shared/SKILL.md` for auth. If missing, run `gws generate-skills` to create it.

```bash
gws fake <resource> <method> [flags]
```

| Command | Description |
|---------|-------------|
| [`+send`](../gws-fake-send/SKILL.md) | Send a thing |

Inspect first: `gws schema fake.things.list`
EOF
printf '# unrelated\n\ngws is mentioned but this is not a gws-* dir\n' > "$TEST_DIR/skills/other-skill/SKILL.md"

# A second fixture whose directory names a service the gateway actually carries.
mkdir -p "$TEST_DIR/skills/gws-gmail-send"
printf '# gmail +send\n\nSend a thing with `gws gmail`.\n' \
    > "$TEST_DIR/skills/gws-gmail-send/SKILL.md"

echo "Running tests for patch-gws-skills..."

# 1. Missing directory -> exit 3.
rc=0
bash "$PATCH" "$TEST_DIR/nope" > /dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || { echo "  Failure: expected exit 3 for missing dir, got $rc"; exit 1; }
echo "  ok: missing dir rejected"

# 2. First run patches the gws skill.
OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":2,"skipped":0}' ] || fail "unexpected summary: $OUT"
skill="$TEST_DIR/skills/gws-fake/SKILL.md"
grep -q -- '- op-gws$' "$skill" || fail "requires.bins entry not rewritten"
grep -q 'cliHelp: "op-gws fake --help"' "$skill" || fail "cliHelp not rewritten"
grep -q '^op-gws fake <resource>' "$skill" || fail "code block command not rewritten"
grep -q 'Inspect first: `op-gws schema' "$skill" || fail "inline command not rewritten"
grep -q '(../gws-fake-send/SKILL.md)' "$skill" || fail "hyphenated link was corrupted"
grep -q '../gws-shared/SKILL.md' "$skill" || fail "shared-skill path was corrupted"
echo "  ok: commands rewritten, names and links preserved"

# 3. Inserted sections sit right after the H1 title: the gateway note first
# (inserted last, so it lands closest to the title), then Accounts.
awk '/^# fake \(v1\)$/{found=1; next} found && NF{if ($0 == "## No MCP gateway tools for this service") exit 0; exit 1}' "$skill" \
    || fail "gateway section not directly after the title"
grep -q 'work-ysf' "$skill" || fail "gap-logging instructions missing"
grep -q 'op-gws --accounts' "$skill" || fail "accounts discovery hint missing"
grep -q '^## Accounts' "$skill" || fail "Accounts section missing"
echo "  ok: gateway and Accounts sections inserted after title"

# 3b. The note is worded per service: gmail has gateway tools, `fake` does not.
gmail_skill="$TEST_DIR/skills/gws-gmail-send/SKILL.md"
grep -q '^## Prefer the MCP gateway' "$gmail_skill" \
    || fail "gmail skill did not get the has-tools wording"
grep -q 'gmail_\*` tools' "$gmail_skill" || fail "gmail tool prefix not named"
grep -q 'the gateway only drafts' "$gmail_skill" || fail "gmail fallback list missing"
if grep -q '^## Prefer the MCP gateway' "$skill"; then
    fail "non-gateway service claimed gateway tools"
fi
echo "  ok: gateway note worded per service"

# 4. Non-gws skill untouched.
grep -q '^gws is mentioned' "$TEST_DIR/skills/other-skill/SKILL.md" \
    || fail "non-gws skill was modified"
echo "  ok: non-gws skill untouched"

# 5. Second run is a no-op.
cp "$skill" "$TEST_DIR/before-rerun"
OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":0,"skipped":2}' ] || fail "second run not skipped: $OUT"
cmp -s "$skill" "$TEST_DIR/before-rerun" || fail "second run changed the file"
echo "  ok: idempotent"

# 6. A skill patched under the retired op-mcp scheme has that note stripped and
# the gateway note put in its place, without re-running the command rewrite.
mkdir -p "$TEST_DIR/skills/gws-legacy"
legacy="$TEST_DIR/skills/gws-legacy/SKILL.md"
cat > "$legacy" <<'LEGACY'
---
name: gws-legacy
metadata:
  openclaw:
    cliHelp: "op-gws legacy --help"
---

# legacy (v1)

## Prefer op-mcp for reads

When the op-mcp MCP tools are available in your session, use its `gws` tool for
read operations instead of the op-gws CLI. Fall back to op-gws when the service
is not running.

## Accounts

Multiple Google accounts may be configured. Run `op-gws --accounts` to list them.

## Body

Inspect first: `op-gws schema legacy.things.list`
LEGACY

OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":1,"skipped":2}' ] || fail "migration run not counted as patched: $OUT"
if grep -q 'op-mcp' "$legacy"; then
    echo "  Failure: retired op-mcp note not stripped"; cat "$legacy"; exit 1
fi
grep -q '^## No MCP gateway tools for this service' "$legacy" \
    || { echo "  Failure: gateway note not added on migration"; cat "$legacy"; exit 1; }
grep -q '^## Accounts' "$legacy" \
    || { echo "  Failure: migration ate the Accounts section"; cat "$legacy"; exit 1; }
[ "$(grep -c 'op-gws legacy --help' "$legacy")" -eq 1 ] \
    || { echo "  Failure: migration re-ran the command rewrite"; cat "$legacy"; exit 1; }
echo "  ok: retired op-mcp note migrated in place"

echo "All patch-gws-skills tests passed!"
