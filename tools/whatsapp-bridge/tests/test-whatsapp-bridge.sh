#!/usr/bin/env bash

# Regression test for the WHATSAPP_STATE_DIR patch: the bridge must create its
# SQLite state under $WHATSAPP_STATE_DIR, never under ./store. Runs the packaged
# binary when it is on PATH (the flake check adds it) and skips from a plain
# checkout. Network-free: the bridge creates its databases before it ever tries
# to reach WhatsApp, and we only assert on the files.

set -euo pipefail

if ! command -v whatsapp-bridge > /dev/null 2>&1; then
    echo "whatsapp-bridge not on PATH; skipping (packaged-only test)"
    exit 0
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/cwd"
cd "$workdir/cwd"

echo "--- whatsapp-bridge: state lands in WHATSAPP_STATE_DIR ---"
WHATSAPP_STATE_DIR="$workdir/state" timeout 20 whatsapp-bridge > /dev/null 2>&1 || true

test -f "$workdir/state/whatsapp.db" || {
    echo "FAIL: whatsapp.db not created in WHATSAPP_STATE_DIR"
    exit 1
}
test ! -e "$workdir/cwd/store" || {
    echo "FAIL: bridge wrote ./store despite WHATSAPP_STATE_DIR"
    exit 1
}

echo "--- whatsapp-bridge: invalid WHATSAPP_BRIDGE_PORT is rejected ---"
out=$(WHATSAPP_STATE_DIR="$workdir/state2" WHATSAPP_BRIDGE_PORT=nonsense timeout 20 whatsapp-bridge 2>&1 || true)
if echo "$out" | grep -q "Invalid WHATSAPP_BRIDGE_PORT"; then
    echo "port validation OK"
else
    # The bridge may exit earlier on connection failure in a sandbox; only
    # fail if it *accepted* the bogus port and started the REST server.
    if echo "$out" | grep -q "REST server"; then
        echo "FAIL: REST server started with an invalid port"
        exit 1
    fi
    echo "port validation not reached (no network); acceptable"
fi

echo "whatsapp-bridge tests passed"
