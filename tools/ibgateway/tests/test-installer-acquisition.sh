#!/usr/bin/env bash
set -euo pipefail

# The IB Gateway installer is only served at mutable channel URLs, so the wrapper
# acquires it at install time. These tests pin the invariants of that design:
# build inputs that CAN be pinned stay pinned (base image digest, IBC), the nix
# build never fetches the gateway installer, and the runtime download path honours
# the local override, the sha256 pin, and trust-on-first-use provenance.

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
dockerfile=$tool_dir/Dockerfile
package=$tool_dir/package.nix
wrapper=$tool_dir/wrapper.sh

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  printf '--- captured output ---\n%s\n' "${OUTPUT:-<none>}" >&2
  exit 1
}

# --- Static invariants -------------------------------------------------------

grep -Eq '^FROM docker\.io/library/ubuntu@sha256:[0-9a-f]{64}$' "$dockerfile" \
  || fail "container base image is not digest-pinned"

if grep -q 'interactivebrokers.com' "$package"; then
  fail "package.nix fetches the gateway installer at build time again"
fi
grep -q 'IBCLinux-${ibcVersion}.zip' "$package" \
  || fail "IBC is no longer version-pinned in package.nix"

grep -Fq '$INSTALLER_PATH:/tmp/$APP_ID-installer.sh:ro' "$wrapper" \
  || fail "wrapper does not mount the acquired installer"

# --- Functional: mocked podman/curl ------------------------------------------

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"

cat > "$TEST_DIR/bin/podman" <<EOF
#!$(command -v bash)
if [[ "\$1" == "image" && "\$2" == "exists" ]]; then
    exit 0
fi
echo "mock-podman: \$*" >&2
exit 0
EOF
chmod +x "$TEST_DIR/bin/podman"

cat > "$TEST_DIR/bin/curl" <<EOF
#!$(command -v bash)
echo "mock-curl: \$*" >&2
out=""
prev=""
for a in "\$@"; do
    if [[ "\$prev" == "-o" ]]; then out=\$a; fi
    prev=\$a
done
if [[ -n "\$out" ]]; then
    echo "downloaded-installer-content" > "\$out"
fi
EOF
chmod +x "$TEST_DIR/bin/curl"

export DOCKERFILE="$dockerfile"

run_wrapper() {
  local home=$1
  shift
  HOME="$home" bash "$wrapper" --screenshot-only "$@" 2>&1
}

echo "Running installer-acquisition tests..."

# 1. Local installer override: no download, mounted into the install container,
#    provenance recorded with its checksum.
home1="$TEST_DIR/home1"
mkdir -p "$home1"
printf 'local-installer-content\n' > "$TEST_DIR/local-installer.sh"
local_sha=$(sha256sum "$TEST_DIR/local-installer.sh" | cut -d' ' -f1)
OUTPUT=$(IBGATEWAY_INSTALLER="$TEST_DIR/local-installer.sh" run_wrapper "$home1")
echo "$OUTPUT" | grep -q "mock-curl" && fail "downloaded despite IBGATEWAY_INSTALLER override"
echo "$OUTPUT" | grep -q -- "-v $TEST_DIR/local-installer.sh:/tmp/ibgateway-installer.sh:ro" \
  || fail "local installer not mounted into install container"
grep -q "sha256=$local_sha" "$home1/.config/ibgateway/installer-provenance" \
  || fail "provenance not recorded for local installer"
echo "  ok: local override"

# 2. Download path: stable channel URL by default, provenance matches the download.
home2="$TEST_DIR/home2"
mkdir -p "$home2"
OUTPUT=$(run_wrapper "$home2")
echo "$OUTPUT" | grep -q "mock-curl: .*ibgateway/stable-standalone/ibgateway-stable-standalone-linux-x64.sh" \
  || fail "stable channel URL not downloaded by default"
downloaded_sha=$(printf 'downloaded-installer-content\n' | sha256sum | cut -d' ' -f1)
grep -q "sha256=$downloaded_sha" "$home2/.config/ibgateway/installer-provenance" \
  || fail "provenance does not match downloaded installer"
echo "  ok: runtime download with provenance"

# 3. Channel selection and validation.
home3="$TEST_DIR/home3"
mkdir -p "$home3"
OUTPUT=$(IBGATEWAY_CHANNEL=latest run_wrapper "$home3")
echo "$OUTPUT" | grep -q "mock-curl: .*latest-standalone-linux-x64.sh" \
  || fail "IBGATEWAY_CHANNEL=latest not honoured"
rc=0
OUTPUT=$(IBGATEWAY_CHANNEL=nightly run_wrapper "$home3") || rc=$?
[ "$rc" -eq 2 ] || fail "invalid channel accepted (rc=$rc)"
echo "  ok: channel selection"

# 4. Hard pin: mismatching IBGATEWAY_INSTALLER_SHA256 refuses to install.
home4="$TEST_DIR/home4"
mkdir -p "$home4"
rc=0
OUTPUT=$(IBGATEWAY_INSTALLER_SHA256="0000000000000000000000000000000000000000000000000000000000000000" \
  run_wrapper "$home4") || rc=$?
[ "$rc" -eq 1 ] || fail "sha256 mismatch did not fail (rc=$rc)"
echo "$OUTPUT" | grep -q "installer sha256 mismatch" || fail "mismatch not reported"
echo "$OUTPUT" | grep -q "mock-podman: run" && fail "install proceeded despite sha256 mismatch"
echo "  ok: sha256 pin enforced"

# 5. Trust-on-first-use: a changed checksum warns but proceeds.
home5="$TEST_DIR/home5"
mkdir -p "$home5/.config/ibgateway"
printf 'sha256=%s\n' "1111111111111111111111111111111111111111111111111111111111111111" \
  > "$home5/.config/ibgateway/installer-provenance"
OUTPUT=$(run_wrapper "$home5")
echo "$OUTPUT" | grep -q "installer checksum changed since the last install" \
  || fail "checksum change did not warn"
grep -q "sha256=$downloaded_sha" "$home5/.config/ibgateway/installer-provenance" \
  || fail "provenance not updated after change"
echo "  ok: trust-on-first-use warning"

printf 'PASS: installer acquisition invariants hold\n'
