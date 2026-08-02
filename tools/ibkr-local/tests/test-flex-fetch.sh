#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}

TOOL_SRC="$tool_dir" python3 "$tool_dir/tests/test-flex-fetch.py"
