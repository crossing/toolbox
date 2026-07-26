#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}

test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

fake_bin="$test_root/bin"
capture_dir="$test_root/captured"
mkdir -p "$fake_bin" "$capture_dir"

bash_path=$(command -v bash)
cat >"$fake_bin/safe-op" <<EOF
#!$bash_path
set -euo pipefail
[[ -p /dev/stdout ]] || {
    echo 'safe-op output was not a pipe' >&2
    exit 90
}
printf '%s\n' "\$*" >>"\$SAFE_OP_LOG"
[[ \$1 == read && \$2 == 'op://Fake/Local/token' && \$3 == --no-newline ]] || exit 91
if [[ \${SAFE_OP_FAIL:-0} == 1 ]]; then
    echo 'mock vault unavailable' >&2
    exit 42
fi
printf '%s' 'fake-local-launcher-token'
EOF

cat >"$fake_bin/opencode" <<EOF
#!$bash_path
set -euo pipefail
mkdir -p "\$TEST_CAPTURE_DIR"
if [[ -f \$TEST_CAPTURE_DIR/calls ]]; then
    call_number=\$((\$(wc -l <"\$TEST_CAPTURE_DIR/calls") + 1))
else
    call_number=1
fi
printf '%s\n' called >>"\$TEST_CAPTURE_DIR/calls"
printf '%s' "\${LLM_PACER_API_KEY-}" >"\$TEST_CAPTURE_DIR/token.\$call_number"
printf '%s\n' "\$@" >"\$TEST_CAPTURE_DIR/args.\$call_number"
tr '\0' '\n' </proc/\$\$/cmdline >"\$TEST_CAPTURE_DIR/argv.\$call_number"
if [[ \${OPENCODE_EXIT:-0} != 0 ]]; then
    echo 'mock OpenCode failed' >&2
    exit "\$OPENCODE_EXIT"
fi
printf '%s\n' '{"mock":"opencode"}'
EOF

chmod +x "$fake_bin/safe-op" "$fake_bin/opencode"

rendered="$test_root/llm-pacer-opencode"
sed \
    -e "s|__LLM_PACER_LOCAL_CREDENTIAL_REF__|'op://Fake/Local/token'|g" \
    -e "s|__LLM_PACER_OPENCODE_COMMAND__|'opencode'|g" \
    "$tool_dir/llm-pacer-opencode.sh" >"$rendered"

export PATH="$fake_bin:$PATH"
export SAFE_OP_LOG="$test_root/safe-op.log"
export TEST_CAPTURE_DIR="$capture_dir"
export LLM_PACER_API_KEY=stale-local-token

bash -euo pipefail "$rendered" --model acme/mock-model 'prompt with spaces' \
    >"$test_root/success.stdout" 2>"$test_root/success.stderr"

[[ $(cat "$SAFE_OP_LOG") == 'read op://Fake/Local/token --no-newline' ]]
[[ $(cat "$capture_dir/token.1") == fake-local-launcher-token ]]
diff -u <(printf '%s\n' --model acme/mock-model 'prompt with spaces') "$capture_dir/args.1"
if grep -aF -e fake-local-launcher-token -e stale-local-token "$capture_dir/argv.1" >/dev/null; then
    echo 'local token appeared in OpenCode argv' >&2
    exit 1
fi

# A child failure must retain its status without exposing the injected token.
export OPENCODE_EXIT=37
if bash -euo pipefail "$rendered" debug config \
    >"$test_root/child-failure.stdout" 2>"$test_root/child-failure.stderr"; then
    echo 'launcher unexpectedly hid the OpenCode failure' >&2
    exit 1
else
    status=$?
fi
[[ $status == 37 ]]
[[ $(cat "$capture_dir/token.2") == fake-local-launcher-token ]]
diff -u <(printf '%s\n' debug config) "$capture_dir/args.2"
if grep -aF -e fake-local-launcher-token -e stale-local-token "$capture_dir/argv.2" >/dev/null; then
    echo 'local token appeared in failed OpenCode argv' >&2
    exit 1
fi

# If 1Password cannot supply a token, llm-pacer must reject the empty pipe and
# OpenCode must never run.
unset OPENCODE_EXIT
export SAFE_OP_FAIL=1
if bash -euo pipefail "$rendered" models llm-pacer \
    >"$test_root/vault-failure.stdout" 2>"$test_root/vault-failure.stderr"; then
    echo 'launcher unexpectedly succeeded with an unavailable vault' >&2
    exit 1
fi
[[ $(wc -l <"$capture_dir/calls") == 2 ]]
[[ $(wc -l <"$SAFE_OP_LOG") == 3 ]]
while IFS= read -r invocation; do
    [[ $invocation == 'read op://Fake/Local/token --no-newline' ]]
done <"$SAFE_OP_LOG"

for output in "$test_root"/*.stdout "$test_root"/*.stderr; do
    if grep -aF -e fake-local-launcher-token -e stale-local-token "$output" >/dev/null; then
        echo "local token appeared in command output: $output" >&2
        exit 1
    fi
done

echo 'llm-pacer OpenCode launcher tests passed'
