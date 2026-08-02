#!/usr/bin/env bash
set -euo pipefail

APP_ID="ibgateway"
APP_LABEL="IB Gateway"
APP_CLI_NAME="ibgateway"

home_default() {
  local value=$1
  case "$value" in
    /*)
      printf '%s\n' "$value"
      ;;
    *)
      printf '%s/%s\n' "$HOME" "$value"
      ;;
  esac
}

usage() {
  cat <<USAGE
Usage: $APP_CLI_NAME [--visible|--x11|--xvfb] [--ibc] [--screenshot-only] [$APP_ID args...]

Modes:
  --visible          Use the current desktop session. This is the default.
  --x11              Use the current X11 DISPLAY and force GDK_BACKEND=x11.
  --xvfb             Start a virtual X11 display with xvfb-run, then launch $APP_LABEL.
  --ibc              Start $APP_LABEL through IBC; requires external IBC config.
  --screenshot-only  Build/install check only; do not start $APP_LABEL.

Environment:
  IBKR_INSTALL_DIR   Persistent app install directory.
  IBKR_CONFIG_DIR    Persistent Jts config directory.
  IBKR_LOG_DIR       Host log directory mounted into the container.
  IBKR_DISPLAY_MODE  visible, x11, xvfb, or ibc.
  IBKR_APP_MODE      direct or ibc.
  IBKR_XVFB_GEOMETRY Xvfb geometry; defaults to 1920x1080x24.
  IBC_INI            Ephemeral local IBC config.
  IBC_APP_VERSION    Override auto-detected app major version for IBC.
  IBKR_TRADING_MODE  Override IBC TradingMode; defaults to ibc.ini.
USAGE

  cat <<'USAGE'
  IBGATEWAY_CHANNEL           Installer channel: stable (default) or latest.
  IBGATEWAY_INSTALLER         Local installer file to use; skips the download.
  IBGATEWAY_INSTALLER_URL     Full installer URL override.
  IBGATEWAY_INSTALLER_SHA256  Refuse any installer with a different checksum.
USAGE

  cat <<'USAGE'
  IBGATEWAY_DIR            Gateway install directory alias.
  IBGATEWAY_CONFIG_DIR     Gateway Jts config directory alias.
  IBGATEWAY_LOG_DIR        Gateway log directory alias.
  IBGATEWAY_DISPLAY_MODE   Gateway display mode alias.
  IBGATEWAY_MODE           Gateway mode alias; "ibc" starts IBC.
  IBGATEWAY_APP_MODE       Gateway app mode alias.
  IBGATEWAY_XVFB_GEOMETRY  Gateway Xvfb geometry alias.
  IBC_GATEWAY_VERSION      Gateway IBC version override alias.
  IBC_GATEWAY_TRADING_MODE Gateway IBC trading mode alias.
USAGE
}

restore_ibc_launchers() {
  if [ ! -e "$INSTALL_DIR/ibgateway" ] && [ -e "$INSTALL_DIR/ibgateway1" ]; then
    mv "$INSTALL_DIR/ibgateway1" "$INSTALL_DIR/ibgateway"
  fi
}

patch_vmoptions_path() {
  local vmoptions="$INSTALL_DIR/$APP_ID.vmoptions"
  [ -f "$vmoptions" ] || return 0
  sed -i "s#^-DvmOptionsPath=.*#-DvmOptionsPath=/opt/ibgateway/latest/$APP_ID.vmoptions#" "$vmoptions"
}

sanitize_output() {
  sed -E \
    -e 's/(jxBrowserKey[[:space:]]*=[[:space:]]*).*/\1***/g' \
    -e 's/(-DjxBrowserKey=).*/\1***/g' \
    -e 's/(IbLoginId[[:space:]]*=[[:space:]]*).*/\1***/g' \
    -e 's/(IbPassword[[:space:]]*=[[:space:]]*).*/\1***/g'
}

detect_versioned_install() {
  local host_root=$1 container_path=$2 version

  [ -d "$host_root" ] || return 1

  version=$(
    find "$host_root" -mindepth 2 -maxdepth 2 -type d -name jars -print 2>/dev/null \
    | sed 's#/jars$##' \
    | sed -n 's#.*/\([0-9][0-9]*\)$#\1#p' \
    | sort -rn \
    | head -n 1
  )

  [ -n "$version" ] || return 1
  printf '%s\t%s\n' "$container_path" "$version"
}

detect_ibc_install() {
  if [ -n "${IBC_VERSION_OVERRIDE:-}" ]; then
    printf '%s\t%s\n' "/opt" "$IBC_VERSION_OVERRIDE"
    return 0
  fi

  if detect_versioned_install "$INSTALL_DIR/ibgateway" "/opt"; then
    return 0
  fi
  if detect_versioned_install "$INSTALL_DIR" "/opt"; then
    return 0
  fi
  if [ -d "$INSTALL_DIR/jars" ]; then
    printf '%s\t%s\n' "/opt" "latest"
    return 0
  fi
  return 0
}

default_install_dir=$(home_default ".local/opt/ibgateway")
default_config_dir=$(home_default ".config/ibgateway")
default_log_dir=$(home_default ".local/state/ibgateway")

DISPLAY_MODE="${IBKR_DISPLAY_MODE:-${IBKR_MODE:-}}"
APP_MODE="${IBKR_APP_MODE:-direct}"
XVFB_GEOMETRY="${IBKR_XVFB_GEOMETRY:-1920x1080x24}"
IBC_VERSION_OVERRIDE="${IBC_APP_VERSION:-${IBKR_IBC_VERSION:-}}"
IBC_TRADING_MODE_VALUE="${IBKR_TRADING_MODE:-}"
INSTALL_DIR="${IBGATEWAY_DIR:-${IBKR_INSTALL_DIR:-$default_install_dir}}"
CONFIG_DIR="${IBGATEWAY_CONFIG_DIR:-${IBKR_CONFIG_DIR:-$default_config_dir}}"
LOG_DIR="${IBGATEWAY_LOG_DIR:-${IBKR_LOG_DIR:-$default_log_dir}}"
DISPLAY_MODE="${IBGATEWAY_DISPLAY_MODE:-${IBGATEWAY_MODE:-${DISPLAY_MODE:-visible}}}"
APP_MODE="${IBGATEWAY_APP_MODE:-$APP_MODE}"
XVFB_GEOMETRY="${IBGATEWAY_XVFB_GEOMETRY:-$XVFB_GEOMETRY}"
IBC_VERSION_OVERRIDE="${IBC_GATEWAY_VERSION:-$IBC_VERSION_OVERRIDE}"
IBC_TRADING_MODE_VALUE="${IBC_GATEWAY_TRADING_MODE:-$IBC_TRADING_MODE_VALUE}"

DISPLAY_MODE="${DISPLAY_MODE:-visible}"
APP_MODE="${APP_MODE:-direct}"

if [ "$DISPLAY_MODE" = "ibc" ]; then
  DISPLAY_MODE="visible"
  APP_MODE="ibc"
fi

SCREENSHOT_ONLY=0
ARGS=()

while (($#)); do
  case "$1" in
    --visible)
      DISPLAY_MODE="visible"
      shift
      ;;
    --x11)
      DISPLAY_MODE="x11"
      shift
      ;;
    --xvfb)
      DISPLAY_MODE="xvfb"
      shift
      ;;
    --ibc)
      APP_MODE="ibc"
      shift
      ;;
    --screenshot-only)
      SCREENSHOT_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

case "$DISPLAY_MODE" in
  visible|x11|xvfb)
    ;;
  *)
    echo "$APP_CLI_NAME: unsupported display mode: $DISPLAY_MODE" >&2
    exit 2
    ;;
esac

case "$APP_MODE" in
  direct|ibc)
    ;;
  *)
    echo "$APP_CLI_NAME: unsupported app mode: $APP_MODE" >&2
    exit 2
    ;;
esac

if [ "$DISPLAY_MODE" = "xvfb" ]; then
  replay_args=(--x11)
  if [ "$APP_MODE" = "ibc" ]; then
    replay_args+=(--ibc)
  fi
  xvfb_child=""
  # shellcheck disable=SC2329 # invoked indirectly by signal/EXIT traps
  cleanup_xvfb_run() {
    if [ -n "$xvfb_child" ]; then
      kill -TERM "$xvfb_child" >/dev/null 2>&1 || true
    fi
    if [ -n "${IBKR_CONTAINER_NAME:-}" ]; then
      podman stop --time 20 "$IBKR_CONTAINER_NAME" >/dev/null 2>&1 || true
      podman rm --force "$IBKR_CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup_xvfb_run EXIT
  trap 'exit 143' HUP INT TERM
  xvfb-run -a --server-args="-screen 0 $XVFB_GEOMETRY" "$0" "${replay_args[@]}" "${ARGS[@]}" &
  xvfb_child=$!
  set +e
  wait "$xvfb_child"
  status=$?
  set -e
  xvfb_child=""
  exit "$status"
fi

if [ "$APP_MODE" = "ibc" ]; then
  if [ -z "${IBC_INI:-}" ]; then
    echo "$APP_CLI_NAME --ibc requires IBC_INI to point at an ephemeral local IBC config" >&2
    exit 2
  fi
  if [ -z "${IBC_DIR:-}" ] || [ ! -d "${IBC_DIR:-}" ]; then
    echo "$APP_CLI_NAME --ibc requires IBC_DIR to point at a packaged IBC directory" >&2
    exit 2
  fi
fi

DOCKERFILE="${DOCKERFILE:?DOCKERFILE is required}"

# IB publishes the gateway only at mutable channel URLs -- there is no versioned
# archive -- so the installer is fetched here at install time instead of in the nix
# build, where a fixed-output hash would break on every IB release. Integrity is
# handled by trust-on-first-use provenance plus an optional hard pin.
INSTALLER_CHANNEL="${IBGATEWAY_CHANNEL:-stable}"
case "$INSTALLER_CHANNEL" in
  stable|latest)
    ;;
  *)
    echo "$APP_CLI_NAME: unsupported IBGATEWAY_CHANNEL: $INSTALLER_CHANNEL (use stable or latest)" >&2
    exit 2
    ;;
esac
INSTALLER_URL="${IBGATEWAY_INSTALLER_URL:-https://download2.interactivebrokers.com/installers/ibgateway/${INSTALLER_CHANNEL}-standalone/ibgateway-${INSTALLER_CHANNEL}-standalone-linux-x64.sh}"

INSTALLER_PATH=""
installer_tmp=""

acquire_installer() {
  if [ -n "${IBGATEWAY_INSTALLER:-}" ]; then
    INSTALLER_PATH="$IBGATEWAY_INSTALLER"
    if [ ! -f "$INSTALLER_PATH" ]; then
      echo "$APP_CLI_NAME: IBGATEWAY_INSTALLER points at a missing file: $INSTALLER_PATH" >&2
      exit 2
    fi
  else
    installer_tmp=$(mktemp -d)
    INSTALLER_PATH="$installer_tmp/$APP_ID-installer.sh"
    echo "Downloading $APP_LABEL installer ($INSTALLER_CHANNEL channel)..."
    curl -fL --retry 3 -o "$INSTALLER_PATH" "$INSTALLER_URL"
  fi

  local installer_sha previous_sha provenance_file
  installer_sha=$(sha256sum "$INSTALLER_PATH" | cut -d' ' -f1)

  if [ -n "${IBGATEWAY_INSTALLER_SHA256:-}" ] && [ "$installer_sha" != "$IBGATEWAY_INSTALLER_SHA256" ]; then
    echo "$APP_CLI_NAME: installer sha256 mismatch" >&2
    echo "  expected: $IBGATEWAY_INSTALLER_SHA256" >&2
    echo "  actual:   $installer_sha" >&2
    exit 1
  fi

  # Trust-on-first-use: the provenance file lives in CONFIG_DIR so it survives an
  # install-dir wipe, which is exactly when the comparison matters.
  provenance_file="$CONFIG_DIR/installer-provenance"
  if [ -f "$provenance_file" ]; then
    previous_sha=$(sed -n 's/^sha256=//p' "$provenance_file" | head -n 1)
    if [ -n "$previous_sha" ] && [ "$previous_sha" != "$installer_sha" ]; then
      {
        echo "WARNING: $APP_LABEL installer checksum changed since the last install."
        echo "  previous: $previous_sha"
        echo "  current:  $installer_sha"
        echo "  Expected when IB ships a new $INSTALLER_CHANNEL release. Set"
        echo "  IBGATEWAY_INSTALLER_SHA256 to refuse unexpected installers."
      } >&2
    fi
  fi
  {
    echo "sha256=$installer_sha"
    echo "source=${IBGATEWAY_INSTALLER:-$INSTALLER_URL}"
    echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$provenance_file"
}

cleanup_installer() {
  if [ -n "$installer_tmp" ]; then
    rm -rf "$installer_tmp"
    installer_tmp=""
  fi
}

IMAGE_NAME="$APP_ID:$(md5sum "$DOCKERFILE" | cut -c1-8)"
USER_ID=$(id -u)
GROUP_ID=$(id -g)
install_marker_path="$INSTALL_DIR/ibgateway"

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$LOG_DIR"
restore_ibc_launchers

if ! podman image exists "$IMAGE_NAME" 2>/dev/null; then
  echo "Building container image $IMAGE_NAME..."
  podman build -t "$IMAGE_NAME" -f "$DOCKERFILE" "$(dirname "$DOCKERFILE")"
fi

if [ ! -f "$install_marker_path" ]; then
  acquire_installer
  echo "Installing $APP_LABEL to $INSTALL_DIR..."

  # Install and capture the bundled JRE in ONE container run: install4j unpacks the
  # JRE under the passwd home of the mapped uid (e.g. /home/ubuntu/.local/share/
  # i4j_jres -- NOT $HOME, which it ignores; 10.48 used /opt/i4j_jres instead), and
  # that location is ephemeral container filesystem, gone once this run exits.
  echo "Running installer and capturing the bundled JRE..."
  podman run --rm \
    --userns=keep-id \
    -u "$USER_ID:$GROUP_ID" \
    -v "$INSTALL_DIR:/opt/ibgateway/latest" \
    -v "$INSTALLER_PATH:/tmp/$APP_ID-installer.sh:ro" \
    -e "HOME=/home/ibgateway" \
    "$IMAGE_NAME" \
    bash -c "set -e ; \
             INSTALL4J_KEEP_TEMP=true bash /tmp/$APP_ID-installer.sh -q -dir '/opt/ibgateway/latest' ; \
             JRE_BIN=\$(find /opt/i4j_jres /home/*/.local/share/i4j_jres \"\$HOME/.local/share/i4j_jres\" -maxdepth 3 -name bin -type d 2>/dev/null | head -n 1) ; \
             if [ -n \"\$JRE_BIN\" ]; then \
               JRE_DIR=\$(dirname \"\$JRE_BIN\") ; \
               echo \"Capturing bundled JRE from \$JRE_DIR to /opt/ibgateway/latest/jre...\" ; \
               mkdir -p '/opt/ibgateway/latest/jre' ; \
               cp -r \"\$JRE_DIR\"/* '/opt/ibgateway/latest/jre/' ; \
             else \
               echo 'WARNING: no bundled JRE found after install; the gateway launcher will likely fail' >&2 ; \
             fi ; \
             if [ -f '/opt/ibgateway/latest/ibgateway' ]; then \
               sed -i 's/ver_minor -lt 16/ver_minor -lt 0/' '/opt/ibgateway/latest/ibgateway' ; \
               sed -i 's/ver_micro -lt 16/ver_micro -lt 0/' '/opt/ibgateway/latest/ibgateway' ; \
             fi ; \
             chown -R $USER_ID:$GROUP_ID '/opt/ibgateway/latest'"

  cleanup_installer
fi

restore_ibc_launchers
patch_vmoptions_path

if [ "$SCREENSHOT_ONLY" = "1" ]; then
  echo "$APP_LABEL image/install check passed for $IMAGE_NAME"
  exit 0
fi

podman_args=(
  --rm
  --net=host
  --userns=keep-id
  --shm-size=2g
  -u "$USER_ID:$GROUP_ID"
  -v "$INSTALL_DIR:/opt/ibgateway/latest"
  -v "$CONFIG_DIR:/home/ibgateway/Jts"
  -v "$LOG_DIR:/home/ibgateway/ibkr-logs"
  -v /tmp/.X11-unix:/tmp/.X11-unix
  -e DISPLAY
  -e "GDK_SCALE=2"
  -e "HOME=/home/ibgateway"
  -e "INSTALL4J_NO_DB=true"
  -e "JAVA_TOOL_OPTIONS=-Dsun.java2d.uiScale=2 -Duser.home=/home/ibgateway"
  -e "INSTALL4J_JAVA_HOME_OVERRIDE=/opt/ibgateway/latest/jre"
)

CONTAINER_NAME=${IBKR_CONTAINER_NAME:-}
if [ -n "$CONTAINER_NAME" ]; then
  case "$CONTAINER_NAME" in
    *[!A-Za-z0-9_.-]*)
      echo "Invalid IBKR_CONTAINER_NAME" >&2
      exit 2
      ;;
  esac
  podman_args+=(--name "$CONTAINER_NAME")
fi

if [ -e /dev/dri ]; then
  podman_args+=(--device /dev/dri)
fi

if [ "$DISPLAY_MODE" = "visible" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && [ -n "${XDG_RUNTIME_DIR:-}" ]; then
  WAYLAND_SOCKET_PATH="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
  podman_args+=(
    -v "$WAYLAND_SOCKET_PATH:$WAYLAND_SOCKET_PATH:ro"
    -e "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
    -e "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
    -e "GDK_BACKEND=wayland"
  )
else
  podman_args+=(-e "GDK_BACKEND=x11")
fi

if [ -n "${XAUTHORITY:-}" ] && [ -f "${XAUTHORITY:-}" ]; then
  podman_args+=(-v "$XAUTHORITY:$XAUTHORITY:ro" -e "XAUTHORITY=$XAUTHORITY")
fi

if [ -n "${IBC_INI:-}" ]; then
  podman_args+=(-v "$IBC_INI:/home/ibgateway/ibc.ini:ro" -e "IBC_INI=/home/ibgateway/ibc.ini")
fi

container_cmd=("/opt/ibgateway/latest/ibgateway" "${ARGS[@]}")

if [ "$APP_MODE" = "ibc" ]; then
  ibc_install=$(detect_ibc_install)
  if [ -z "$ibc_install" ]; then
    echo "$APP_CLI_NAME --ibc could not auto-detect an installed $APP_LABEL layout under $INSTALL_DIR" >&2
    echo "Set IBC_APP_VERSION, or launch $APP_CLI_NAME once without --ibc to complete installation." >&2
    exit 2
  fi
  ibc_app_path=${ibc_install%%$'\t'*}
  app_major_version=${ibc_install#*$'\t'}

  podman_args+=(
    -v "$IBC_DIR:/opt/ibc:ro"
    -e "IBC_VRSN=${IBC_VERSION:-unknown}"
  )

  container_cmd=(
    bash
    /opt/ibc/scripts/ibcstart.sh
    "$app_major_version"
  )

  container_cmd+=(--gateway)

  container_cmd+=(
    --tws-path="$ibc_app_path"
    --tws-settings-path=/home/ibgateway/Jts
    --ibc-path=/opt/ibc
    --ibc-ini=/home/ibgateway/ibc.ini
    --java-path="/opt/ibgateway/latest/jre/bin"
    --on2fatimeout=exit
  )

  if [ -n "${IBC_TRADING_MODE_VALUE:-}" ]; then
    container_cmd+=(--mode="$IBC_TRADING_MODE_VALUE")
  fi
fi

if [ "$APP_MODE" = "ibc" ]; then
  # shellcheck disable=SC2329 # invoked indirectly by the EXIT trap
  cleanup_ibc_run() {
    if [ -n "$CONTAINER_NAME" ]; then
      podman stop --time 20 "$CONTAINER_NAME" >/dev/null 2>&1 || true
      podman rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
    restore_ibc_launchers
  }
  trap cleanup_ibc_run EXIT
  trap 'exit 143' HUP INT TERM
  set +e
  podman run "${podman_args[@]}" "$IMAGE_NAME" "${container_cmd[@]}" 2>&1 | sanitize_output
  status=${PIPESTATUS[0]}
  set -e
  exit "$status"
fi

exec podman run "${podman_args[@]}" "$IMAGE_NAME" "${container_cmd[@]}"
