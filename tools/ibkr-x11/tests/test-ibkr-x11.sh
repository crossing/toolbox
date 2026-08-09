#!/usr/bin/env bash

# Unit tests for ibkr-x11

set -e

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Locate the tool. TOOL_SRC lets `nix flake check` point at the store copy; the
# script_dir fallback keeps `bash tools/ibkr-x11/tests/test-ibkr-x11.sh` working from
# anywhere. Never chmod the source: under nix the tool dir is a read-only store path.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
TOOL="$tool_dir/ibkr-x11.sh"
[ -f "$TOOL" ] || { echo "cannot find ibkr-x11.sh at $TOOL"; exit 1; }

# Fake /proc tree with the gateway process environment.
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/proc/4242"
printf 'LANG=C\0DISPLAY=:102\0XAUTHORITY=/tmp/xauth-test\0HOME=/nonexistent\0' \
  > "$TEST_DIR/proc/4242/environ"

# Mock the external commands the tool discovers processes and drives X11 with.
cat > "$TEST_DIR/bin/ps" <<EOF
#!$(command -v bash)
echo '   4242 podman run --name ibkr-gateway-pension-live --rm gateway-image'
echo '   5555 podman run --name ibkr-gateway-main-live --rm gateway-image'
echo '   6666 grep podman run'
EOF

cat > "$TEST_DIR/bin/xdotool" <<EOF
#!$(command -v bash)
echo "xdotool DISPLAY=\$DISPLAY XAUTHORITY=\$XAUTHORITY args=\$*"
EOF

cat > "$TEST_DIR/bin/import" <<EOF
#!$(command -v bash)
echo "import DISPLAY=\$DISPLAY args=\$*"
touch "\${@: -1}"
EOF

chmod +x "$TEST_DIR/bin/ps" "$TEST_DIR/bin/xdotool" "$TEST_DIR/bin/import"
export PATH="$TEST_DIR/bin:$PATH"
export IBKR_X11_PROC_ROOT="$TEST_DIR/proc"

echo "Running tests for ibkr-x11..."

echo "--- env resolves the display from the profile's podman process"
out=$(bash "$TOOL" pension-live env)
echo "$out" | grep -q '"display":":102"' || { echo "  Failure: $out"; exit 1; }
echo "$out" | grep -q '"xauthority":"/tmp/xauth-test"' || { echo "  Failure: $out"; exit 1; }
echo "$out" | grep -q '"pid":4242' || { echo "  Failure: $out"; exit 1; }
echo "  Success."

echo "--- xdotool passthrough exports DISPLAY and XAUTHORITY"
out=$(bash "$TOOL" pension-live xdotool mousemove 505 765 click 1)
echo "$out" | grep -q 'DISPLAY=:102' || { echo "  Failure: $out"; exit 1; }
echo "$out" | grep -q 'XAUTHORITY=/tmp/xauth-test' || { echo "  Failure: $out"; exit 1; }
echo "$out" | grep -q 'args=mousemove 505 765 click 1' || { echo "  Failure: $out"; exit 1; }
echo "  Success."

echo "--- unknown profile fails with a structured error"
if bash "$TOOL" nonexistent env > "$TEST_DIR/out" 2>&1; then
  echo "  Failure: should have exited non-zero"; exit 1
fi
grep -q 'no_gateway_process' "$TEST_DIR/out" || { echo "  Failure: $(cat "$TEST_DIR/out")"; exit 1; }
echo "  Success."

echo "--- screenshot captures the root window to an owner-only file"
out=$(bash "$TOOL" pension-live screenshot "$TEST_DIR/shot.png")
[ -f "$TEST_DIR/shot.png" ] || { echo "  Failure: no screenshot written"; exit 1; }
perms=$(stat -c %a "$TEST_DIR/shot.png")
[ "$perms" = "600" ] || { echo "  Failure: perms $perms"; exit 1; }
echo "$out" | grep -q '"window":"root"' || { echo "  Failure: $out"; exit 1; }
echo "  Success."

echo "--- missing arguments print usage"
if bash "$TOOL" pension-live > "$TEST_DIR/out" 2>&1; then
  echo "  Failure: should have exited non-zero"; exit 1
fi
grep -q 'usage:' "$TEST_DIR/out" || { echo "  Failure: $(cat "$TEST_DIR/out")"; exit 1; }
echo "  Success."

echo "All ibkr-x11 tests passed!"
