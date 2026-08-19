#!/usr/bin/env bash

# Runs the op-mcp Python unit tests. Location-independent: works from a checkout
# and from a read-only nix store path, and never touches op, safe-op, the mcp
# SDK, or the network.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$tool_dir/src${PYTHONPATH:+:$PYTHONPATH}"

for test in test_classify test_plans test_ancestry test_socket; do
    echo "--- op-mcp: $test ---"
    python3 "$tool_dir/tests/$test.py"
done

# Smoke-test the packaged entry point when it is on PATH (the flake check adds
# it). --help must work without a config file, a socket, or 1Password.
if command -v op-mcp > /dev/null 2>&1; then
    echo "--- op-mcp: --help smoke test ---"
    op-mcp --help > /dev/null
    op-mcp plan --help > /dev/null
fi
