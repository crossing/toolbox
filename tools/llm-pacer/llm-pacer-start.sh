# shellcheck shell=bash

if [[ -z ${XDG_RUNTIME_DIR:-} || ${XDG_RUNTIME_DIR:0:1} != / ]]; then
    echo 'llm-pacer-start: XDG_RUNTIME_DIR must be an absolute path' >&2
    exit 1
fi

runtime_base="$XDG_RUNTIME_DIR/llm-pacer"
credentials="$runtime_base/credentials"
install -d -m 0700 -- "$runtime_base"

exec {lock_fd}>"$runtime_base/start.lock"
flock "$lock_fd"

# A running process has already consumed its systemd credential copies. Do not
# consult 1Password or replace that process.
if systemctl --user --quiet is-active llm-pacer.service; then
    exit 0
fi

rm -rf -- "$credentials"
stage=$(mktemp -d "$runtime_base/stage.XXXXXX")
stop_on_exit=0
# Invoked indirectly by the trap below.
# shellcheck disable=SC2329
cleanup() {
    if [[ ${stop_on_exit:-0} == 1 ]]; then
        systemctl --user stop llm-pacer.service >/dev/null 2>&1 || true
    fi
    if [[ -n ${stage:-} ]]; then
        rm -rf -- "$stage"
    fi
    rm -rf -- "$credentials"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

safe-op read __LLM_PACER_UPSTREAM_CREDENTIAL_REF__ --no-newline |
    llm-pacer credential-write "$stage/upstream-api-key"
safe-op read __LLM_PACER_LOCAL_CREDENTIAL_REF__ --no-newline |
    llm-pacer credential-write "$stage/local-api-key"

mv -T -- "$stage" "$credentials"
stage=
stop_on_exit=1
systemctl --user start llm-pacer.service

for _ in $(seq 1 150); do
    if systemctl --user --quiet is-active llm-pacer.service &&
        curl --fail --silent --show-error --max-time 1 __LLM_PACER_HEALTH_URL__ >/dev/null; then
        stop_on_exit=0
        exit 0
    fi
    if systemctl --user --quiet is-failed llm-pacer.service; then
        break
    fi
    sleep 0.1
done

echo 'llm-pacer-start: service did not become healthy' >&2
exit 1
