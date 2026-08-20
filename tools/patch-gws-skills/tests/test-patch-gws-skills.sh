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

echo "Running tests for patch-gws-skills..."

# 1. Missing directory -> exit 3.
rc=0
bash "$PATCH" "$TEST_DIR/nope" > /dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || { echo "  Failure: expected exit 3 for missing dir, got $rc"; exit 1; }
echo "  ok: missing dir rejected"

# 2. First run patches the gws skill.
OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":1,"skipped":0}' ] || fail "unexpected summary: $OUT"
skill="$TEST_DIR/skills/gws-fake/SKILL.md"
grep -q -- '- op-gws$' "$skill" || fail "requires.bins entry not rewritten"
grep -q 'cliHelp: "op-gws fake --help"' "$skill" || fail "cliHelp not rewritten"
grep -q '^op-gws fake <resource>' "$skill" || fail "code block command not rewritten"
grep -q 'Inspect first: `op-gws schema' "$skill" || fail "inline command not rewritten"
grep -q '(../gws-fake-send/SKILL.md)' "$skill" || fail "hyphenated link was corrupted"
grep -q '../gws-shared/SKILL.md' "$skill" || fail "shared-skill path was corrupted"
echo "  ok: commands rewritten, names and links preserved"

# 3. Inserted sections sit right after the H1 title: the op-mcp read-path note
# first (inserted last, so it lands closest to the title), then Accounts.
awk '/^# fake \(v1\)$/{found=1; next} found && NF{if ($0 == "## Prefer op-mcp for reads") exit 0; exit 1}' "$skill" \
    || fail "op-mcp section not directly after the title"
grep -q 'op-gws --accounts' "$skill" || fail "accounts discovery hint missing"
grep -q '^## Accounts' "$skill" || fail "Accounts section missing"
echo "  ok: op-mcp and Accounts sections inserted after title"

# 4. Non-gws skill untouched.
grep -q '^gws is mentioned' "$TEST_DIR/skills/other-skill/SKILL.md" \
    || fail "non-gws skill was modified"
echo "  ok: non-gws skill untouched"

# 5. Second run is a no-op.
cp "$skill" "$TEST_DIR/before-rerun"
OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":0,"skipped":1}' ] || fail "second run not skipped: $OUT"
cmp -s "$skill" "$TEST_DIR/before-rerun" || fail "second run changed the file"
echo "  ok: idempotent"

# 6. A skill patched before the op-mcp note existed gains it without a re-rewrite.
grep -v '^## Prefer op-mcp for reads$' "$skill" \
    | grep -v 'op-mcp' > "$TEST_DIR/skills/gws-fake/SKILL.md.old"
mv "$TEST_DIR/skills/gws-fake/SKILL.md.old" "$skill"
OUT=$(bash "$PATCH" "$TEST_DIR/skills" 2> /dev/null)
[ "$OUT" = '{"patched":1,"skipped":0}' ] || fail "upgrade run not counted as patched: $OUT"
grep -q '^## Prefer op-mcp for reads' "$skill" || fail "op-mcp note not added on upgrade"
[ "$(grep -c 'op-gws fake --help' "$skill")" -eq 1 ] || fail "upgrade re-ran the command rewrite"
echo "  ok: pre-op-mcp skills upgraded in place"

echo "All patch-gws-skills tests passed!"
