#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}

test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

fake_bin="$test_root/bin"
mkdir -p "$fake_bin"

bash_path=$(command -v bash)
cat >"$fake_bin/safe-op" <<EOF
#!$bash_path
set -euo pipefail
[[ -p /dev/stdout ]] || exit 90
printf '%s\n' "\$*" >>"\$SAFE_OP_LOG"
if [[ \${SAFE_OP_FAIL:-0} == 1 ]]; then
    exit 42
fi
[[ \$1 == read && \$3 == --no-newline ]]
case \$2 in
    op://Fake/Upstream/token) printf '%s' 'fake-upstream-test-token' ;;
    op://Fake/Local/token) printf '%s' 'fake-local-test-token' ;;
    *) exit 43 ;;
esac
EOF

cat >"$fake_bin/systemctl" <<EOF
#!$bash_path
set -euo pipefail
case "\$*" in
    *"is-active llm-pacer.service")
        [[ -f \$TEST_STATE_DIR/active ]]
        ;;
    *"is-failed llm-pacer.service")
        exit 1
        ;;
    *"start llm-pacer.service")
        credentials="\$XDG_RUNTIME_DIR/llm-pacer/credentials"
        [[ -f \$credentials/upstream-api-key ]]
        [[ -f \$credentials/local-api-key ]]
        [[ \$(stat -c '%a' "\$credentials/upstream-api-key") == 400 ]]
        [[ \$(stat -c '%a' "\$credentials/local-api-key") == 400 ]]
        mkdir -p "\$TEST_CAPTURE_DIR" "\$TEST_STATE_DIR"
        cp "\$credentials/upstream-api-key" "\$TEST_CAPTURE_DIR/upstream-api-key"
        cp "\$credentials/local-api-key" "\$TEST_CAPTURE_DIR/local-api-key"
        printf '%s\n' start >>"\$TEST_STATE_DIR/start-calls"
        if [[ ! -f \$TEST_STATE_DIR/main-pid ]]; then
            printf '%s' 424242 >"\$TEST_STATE_DIR/main-pid"
        fi
        touch "\$TEST_STATE_DIR/active"
        rm -rf -- "\$credentials"
        ;;
    *"stop llm-pacer.service")
        printf '%s\n' stop >>"\$TEST_STATE_DIR/stop-calls"
        rm -f -- "\$TEST_STATE_DIR/active"
        ;;
    *)
        exit 44
        ;;
esac
EOF

cat >"$fake_bin/curl" <<EOF
#!$bash_path
set -euo pipefail
[[ \${CURL_FAIL:-0} != 1 ]]
[[ -f \$TEST_STATE_DIR/active ]]
EOF

cat >"$fake_bin/sleep" <<EOF
#!$bash_path
exit 0
EOF

chmod +x "$fake_bin/safe-op" "$fake_bin/systemctl" "$fake_bin/curl" "$fake_bin/sleep"

rendered="$test_root/llm-pacer-start"
sed \
    -e "s|__LLM_PACER_UPSTREAM_CREDENTIAL_REF__|'op://Fake/Upstream/token'|g" \
    -e "s|__LLM_PACER_LOCAL_CREDENTIAL_REF__|'op://Fake/Local/token'|g" \
    -e "s|__LLM_PACER_HEALTH_URL__|'http://127.0.0.1:4000/healthz'|g" \
    "$tool_dir/llm-pacer-start.sh" >"$rendered"

export PATH="$fake_bin:$PATH"
export SAFE_OP_LOG="$test_root/safe-op.log"
export TEST_STATE_DIR="$test_root/state"
export TEST_CAPTURE_DIR="$test_root/captured"
export XDG_RUNTIME_DIR="$test_root/runtime"
mkdir -p "$XDG_RUNTIME_DIR"

bash -euo pipefail "$rendered" >"$test_root/first.stdout" 2>"$test_root/first.stderr"

[[ $(wc -l <"$SAFE_OP_LOG") == 2 ]]
[[ $(wc -l <"$TEST_STATE_DIR/start-calls") == 1 ]]
[[ $(cat "$TEST_STATE_DIR/main-pid") == 424242 ]]
[[ $(cat "$TEST_CAPTURE_DIR/upstream-api-key") == fake-upstream-test-token ]]
[[ $(cat "$TEST_CAPTURE_DIR/local-api-key") == fake-local-test-token ]]
[[ ! -e "$XDG_RUNTIME_DIR/llm-pacer/credentials" ]]
if find "$XDG_RUNTIME_DIR/llm-pacer" -maxdepth 1 -name 'stage.*' | grep -q .; then
    echo 'starter left a staging directory behind' >&2
    exit 1
fi

# A second invocation must return before consulting 1Password or replacing the
# existing process, even if the secret source would now fail.
export SAFE_OP_FAIL=1
bash -euo pipefail "$rendered" >"$test_root/second.stdout" 2>"$test_root/second.stderr"
[[ $(wc -l <"$SAFE_OP_LOG") == 2 ]]
[[ $(wc -l <"$TEST_STATE_DIR/start-calls") == 1 ]]
[[ $(cat "$TEST_STATE_DIR/main-pid") == 424242 ]]

# A process started by this invocation must be stopped if it never becomes
# healthy. This must not change the already-active no-op behavior above.
unset SAFE_OP_FAIL
export CURL_FAIL=1
export TEST_STATE_DIR="$test_root/unhealthy-state"
export TEST_CAPTURE_DIR="$test_root/unhealthy-captured"
export XDG_RUNTIME_DIR="$test_root/unhealthy-runtime"
mkdir -p "$XDG_RUNTIME_DIR"
if bash -euo pipefail "$rendered" >"$test_root/unhealthy.stdout" 2>"$test_root/unhealthy.stderr"; then
    echo 'starter unexpectedly accepted an unhealthy service' >&2
    exit 1
fi
[[ $(wc -l <"$TEST_STATE_DIR/start-calls") == 1 ]]
[[ $(wc -l <"$TEST_STATE_DIR/stop-calls") == 1 ]]
[[ ! -e "$TEST_STATE_DIR/active" ]]
[[ ! -e "$XDG_RUNTIME_DIR/llm-pacer/credentials" ]]

# An inactive service with an unavailable vault must not start and must clean
# all staged credential material.
unset CURL_FAIL
export SAFE_OP_FAIL=1
export TEST_STATE_DIR="$test_root/failing-state"
export TEST_CAPTURE_DIR="$test_root/failing-captured"
export XDG_RUNTIME_DIR="$test_root/failing-runtime"
mkdir -p "$XDG_RUNTIME_DIR"
if bash -euo pipefail "$rendered" >"$test_root/failing.stdout" 2>"$test_root/failing.stderr"; then
    echo 'starter unexpectedly succeeded with an unavailable secret source' >&2
    exit 1
fi
[[ ! -e "$TEST_STATE_DIR/start-calls" ]]
[[ ! -e "$XDG_RUNTIME_DIR/llm-pacer/credentials" ]]
if find "$XDG_RUNTIME_DIR/llm-pacer" -maxdepth 1 -name 'stage.*' | grep -q .; then
    echo 'failed starter left a staging directory behind' >&2
    exit 1
fi

for output in "$test_root"/*.stdout "$test_root"/*.stderr; do
    if grep -F -e fake-upstream-test-token -e fake-local-test-token "$output" >/dev/null; then
        echo "secret appeared in command output: $output" >&2
        exit 1
    fi
done

[[ $(wc -l <"$SAFE_OP_LOG") == 5 ]]

echo 'llm-pacer starter tests passed'
