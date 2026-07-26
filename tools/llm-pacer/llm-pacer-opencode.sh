# shellcheck shell=bash

command_path=$(command -v -- __LLM_PACER_OPENCODE_COMMAND__) || {
    echo 'llm-pacer-opencode: OpenCode command not found' >&2
    exit 1
}

# The token travels directly from safe-op to llm-pacer over a pipe. It is
# never expanded into this shell's variables or command arguments.
exec {token_fd}< <(
    safe-op read __LLM_PACER_LOCAL_CREDENTIAL_REF__ --no-newline
)
exec llm-pacer exec-with-local-token --fd "$token_fd" -- "$command_path" "$@"
