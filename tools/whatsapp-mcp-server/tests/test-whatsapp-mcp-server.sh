#!/usr/bin/env bash

# Verifies the read-only gate: send tools must register only when
# WHATSAPP_MCP_ALLOW_SEND=1. Needs the mcp SDK, so it runs against the
# package's virtualenv python (the flake check puts it on PATH) and skips
# from a plain checkout without the SDK.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}

if ! python3 -c "import mcp" > /dev/null 2>&1; then
    echo "mcp SDK not importable; skipping (packaged-only test)"
    exit 0
fi

# From a checkout the package itself is not installed in the venv under test,
# so make the sources importable either way.
export PYTHONPATH="$tool_dir/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1

echo "--- whatsapp-mcp-server: read-only by default ---"
env -u WHATSAPP_MCP_ALLOW_SEND python3 "$tool_dir/tests/test_gating.py" readonly

echo "--- whatsapp-mcp-server: send tools appear with WHATSAPP_MCP_ALLOW_SEND=1 ---"
WHATSAPP_MCP_ALLOW_SEND=1 python3 "$tool_dir/tests/test_gating.py" sendable

echo "whatsapp-mcp-server tests passed"
