#!/usr/bin/env bash

# Attach X11 tooling to a headless IBKR Gateway profile's display.
#
# The ibkr-gateway-<profile> user services run IB Gateway inside podman against a
# private Xvfb display. Diagnosing a stuck login (e.g. a Second Factor
# Authentication dialog) means finding that display and its cookie; this wrapper
# resolves both from the profile's podman process, so callers never need
# XAUTHORITY=/DISPLAY= env prefixes.

set -euo pipefail

usage() {
  {
    echo "usage: ibkr-x11 <profile> env"
    echo "       ibkr-x11 <profile> screenshot <out.png> [window-name-regex]"
    echo "       ibkr-x11 <profile> xdotool <args...>"
    echo "       ibkr-x11 <profile> import <args...>"
  } >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
profile=$1
command=$2
shift 2

# Overridable so tests can fake a /proc tree.
proc_root=${IBKR_X11_PROC_ROOT:-/proc}

pid=$(ps -eo pid=,args= | awk -v name="--name ibkr-gateway-$profile" \
  '/podman run/ && index($0, name) { print $1; exit }')
if [ -z "$pid" ]; then
  printf '{"ok":false,"error":{"code":"no_gateway_process","message":"no podman run process found for profile %s"}}\n' "$profile"
  exit 1
fi

display=$(tr '\0' '\n' <"$proc_root/$pid/environ" | sed -n 's/^DISPLAY=//p')
xauthority=$(tr '\0' '\n' <"$proc_root/$pid/environ" | sed -n 's/^XAUTHORITY=//p')
if [ -z "$display" ] || [ -z "$xauthority" ]; then
  printf '{"ok":false,"error":{"code":"no_display","message":"gateway process %s has no DISPLAY or XAUTHORITY"}}\n' "$pid"
  exit 1
fi

export DISPLAY=$display
export XAUTHORITY=$xauthority

case $command in
  env)
    printf '{"ok":true,"profile":"%s","pid":%s,"display":"%s","xauthority":"%s"}\n' \
      "$profile" "$pid" "$display" "$xauthority"
    ;;
  screenshot)
    [ "$#" -ge 1 ] || usage
    out=$1
    window=root
    if [ "$#" -ge 2 ]; then
      window=$(xdotool search --name "$2" | head -n 1 || true)
      if [ -z "$window" ]; then
        printf '{"ok":false,"error":{"code":"no_window","message":"no window matching %s on display %s"}}\n' "$2" "$display"
        exit 1
      fi
    fi
    import -window "$window" "$out"
    chmod 600 "$out"
    printf '{"ok":true,"path":"%s","window":"%s"}\n' "$out" "$window"
    ;;
  xdotool)
    exec xdotool "$@"
    ;;
  import)
    exec import "$@"
    ;;
  *)
    usage
    ;;
esac
