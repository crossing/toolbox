#!/usr/bin/env bash
set -euo pipefail

readonly APP_NAME="ibkr"

config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
local_config_dir="${IBKR_LOCAL_CONFIG_DIR:-$config_home/ibkr-local}"
profiles_json="${IBKR_LOCAL_PROFILES:-$local_config_dir/profiles.json}"
ibkr_xdg_home="${IBKR_LOCAL_XDG_CONFIG_HOME:-$local_config_dir}"

usage() {
  cat <<'USAGE'
Usage: ibkr <command> [options]

Profile options:
  -p, --profile NAME       Local runtime profile (default from profiles.json)
  -g, --group NAME         Account group filter: margin, cash, isa, pension
  --account ACCOUNT        Restrict to one IBKR account id
  --raw                    Print upstream JSON without local account filtering

Flex history options:
  --kind KIND              raw (default) | trades | transfers | dividends
  --flex-query NAME        Named profile Flex query (required when ambiguous)
  --from YYYY-MM-DD        First report date (requires --to)
  --to YYYY-MM-DD          Last report date, inclusive (requires --from)
  -d, --days DAYS          Lookback ending today (default 365)

Commands:
  doctor                   JSON connectivity/config diagnostic
  connect                  JSON TCP/API connectivity test
  positions                JSON positions with market value and P&L fields
  balances                 JSON account summary
  executions               JSON order executions
  bars SYMBOL              JSON historical OHLCV bars for one symbol (not account-scoped)
  flex                     JSON Flex history: raw statement XML chunks (default) or parsed rows
  order-preview buy|sell   What-if order preview only; --submit is blocked
  order-prepare buy|sell   Preview and create a short-lived guarded order ticket
  order-submit TICKET      Submit one prepared ticket with matching confirmation
  order-cancel ORDER_ID    Cancel one order with explicit profile/account/confirmation
  config path|show         Print local/upstream config paths or local config
  gateway                  Launch IB Gateway for a local profile
  ibc-config               Render ephemeral IBC config from safe-op secret refs

Examples:
  ibkr positions --profile main-paper --group isa
  ibkr balances --profile main-live --account U1234567
  ibkr bars META --profile main-live --bar-size '5 mins' --duration '1 D' --all-hours
  ibkr flex --profile main-live --flex-query nav-daily --json
  ibkr flex --kind trades --profile main-live --flex-query tax-activity --account U1234567 --from 2025-04-06 --to 2026-04-05
  ibkr order-preview buy AAPL 1 --profile main-paper --limit 100 --json
USAGE
}

die() {
  printf '%s: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

require_config() {
  [[ -f "$profiles_json" ]] || die "missing profile config: $profiles_json"
}

jq_profile() {
  local profile=$1 expr=$2
  jq -er --arg profile "$profile" "$expr" "$profiles_json"
}

default_profile() {
  jq -er '.defaultProfile // (.profiles | keys[0])' "$profiles_json"
}

profile_string() {
  local profile=$1 key=$2 fallback=${3:-}
  jq -er --arg profile "$profile" --arg key "$key" --arg fallback "$fallback" \
    '.profiles[$profile][$key] // $fallback' "$profiles_json"
}

account_ids_json() {
  local profile=$1 group=$2
  if [[ -z "$group" ]]; then
    jq -cn '[]'
    return
  fi
  jq -c --arg profile "$profile" --arg group "$group" '
    ((.profiles[$profile].accounts[$group] // .accounts[$group] // []) | map(tostring))
  ' "$profiles_json"
}

filter_accounts() {
  local profile=$1 group=$2 account=$3
  local ids_json
  if [[ -n "$account" ]]; then
    ids_json=$(jq -cn --arg account "$account" '[$account]')
  else
    ids_json=$(account_ids_json "$profile" "$group")
  fi

  if [[ "$ids_json" == "[]" ]]; then
    cat
    return
  fi

  jq --argjson ids "$ids_json" '
    def acct:
      (.account // .accountId // .account_id // .acctId // .acct_id // .AccountID // .accountNumber // empty)
      | tostring;
    def keep:
      (acct as $acct | ($ids | index($acct)) != null);
    def walk_filter:
      if type == "array" then map(if type == "object" and ((acct? // "") != "") then select(keep) else . end)
      elif type == "object" then with_entries(.value |= walk_filter)
      else .
      end;
    walk_filter
  '
}

safe_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --submit|submit|cancel|modify)
        die "live order mutation is blocked; use ibkr order-preview for what-if only"
        ;;
    esac
  done
}

parse_common() {
  profile=""
  group=""
  account=""
  raw=0
  remaining=()

  while (($#)); do
    case "$1" in
      -p|--profile)
        (($# >= 2)) || die "$1 requires a value"
        profile=$2
        shift 2
        ;;
      -g|--group)
        (($# >= 2)) || die "$1 requires a value"
        group=$2
        shift 2
        ;;
      --account)
        (($# >= 2)) || die "$1 requires a value"
        account=$2
        shift 2
        ;;
      --raw)
        raw=1
        shift
        ;;
      *)
        remaining+=("$1")
        shift
        ;;
    esac
  done

  if [[ -z "$profile" ]]; then
    profile=$(default_profile)
  fi
}

ibkr_profile_name() {
  local profile=$1
  profile_string "$profile" "ibkrProfile" "$profile"
}

run_ibkr_json() {
  local profile=$1 group=$2 account=$3 raw=$4
  local forward_account=$5
  shift 5

  local ib_profile
  ib_profile=$(ibkr_profile_name "$profile")

  local -a command=("$@")
  if [[ "$forward_account" == "1" && -n "$account" ]]; then
    command+=(--account "$account")
  fi

  local output
  if ! output=$(XDG_CONFIG_HOME="$ibkr_xdg_home" "${IBKR_UPSTREAM:?IBKR_UPSTREAM is required}" "${command[@]}" --profile "$ib_profile" --json); then
    printf '%s\n' "$output" >&2
    return 1
  fi

  local json_output
  if ! json_output=$(extract_json_payload "$output"); then
    printf '%s\n' "$output" >&2
    return 1
  fi

  if [[ "$raw" == "1" ]]; then
    printf '%s\n' "$json_output"
  else
    printf '%s\n' "$json_output" | filter_accounts "$profile" "$group" "$account"
  fi
}

extract_json_payload() {
  local output=$1 payload
  payload=$(printf '%s\n' "$output" | awk '
    !started && ($0 ~ /^[[:space:]]*\{/ || $0 ~ /^[[:space:]]*\[/) { started = 1 }
    started { print }
  ')
  [[ -n "$payload" ]] || return 1
  jq -e . >/dev/null <<<"$payload" || return 1
  jq -c . <<<"$payload"
}

resolve_flex_dates() {
  local from_date="" to_date="" days=""

  while (($#)); do
    case "$1" in
      --from|--from-date)
        (($# >= 2)) || die "$1 requires a value"
        from_date=$2
        shift 2
        ;;
      --to|--to-date)
        (($# >= 2)) || die "$1 requires a value"
        to_date=$2
        shift 2
        ;;
      -d|--days)
        (($# >= 2)) || die "$1 requires a value"
        days=$2
        shift 2
        ;;
      --json)
        shift
        ;;
      *)
        die "unknown Flex history option: $1"
        ;;
    esac
  done

  if [[ -n "$days" && ( -n "$from_date" || -n "$to_date" ) ]]; then
    die "--days cannot be combined with --from or --to"
  fi
  if [[ -n "$from_date" || -n "$to_date" ]]; then
    [[ -n "$from_date" && -n "$to_date" ]] || die "--from and --to must be provided together"
  else
    if [[ -z "$days" ]]; then
      days=365
    fi
    [[ "$days" =~ ^[1-9][0-9]*$ ]] || die "--days must be a positive integer"
    to_date=$(date -I)
    from_date=$(date -I -d "$to_date - $((days - 1)) days")
  fi

  local normalized_from normalized_to
  [[ "$from_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
    || die "--from must use YYYY-MM-DD"
  [[ "$to_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
    || die "--to must use YYYY-MM-DD"
  normalized_from=$(date -I -d "$from_date" 2>/dev/null) \
    || die "--from must be a valid calendar date"
  normalized_to=$(date -I -d "$to_date" 2>/dev/null) \
    || die "--to must be a valid calendar date"
  [[ "$normalized_from" == "$from_date" ]] || die "--from must be a valid calendar date"
  [[ "$normalized_to" == "$to_date" ]] || die "--to must be a valid calendar date"
  [[ "$from_date" < "$to_date" || "$from_date" == "$to_date" ]] \
    || die "--from must not be after --to"

  flex_from_date=$from_date
  flex_to_date=$to_date
}

run_flex() {
  local profile=$1 group=$2 requested_account=$3
  shift 3

  [[ -z "$group" ]] || die "--group is not supported for Flex history"
  jq -e --arg profile "$profile" '.profiles[$profile] != null' "$profiles_json" >/dev/null \
    || die "unknown profile: $profile"

  local kind="raw" requested_query="" query_count query query_id token_ref token_file
  local -a date_args=()
  while (($#)); do
    case "$1" in
      --kind)
        (($# >= 2)) || die "$1 requires a value"
        kind=$2
        shift 2
        ;;
      --flex-query)
        (($# >= 2)) || die "$1 requires a value"
        requested_query=$2
        shift 2
        ;;
      *)
        date_args+=("$1")
        shift
        ;;
    esac
  done

  case "$kind" in
    raw|trades|transfers|dividends) ;;
    *)
      die "unknown Flex kind: $kind (expected raw, trades, transfers, or dividends)"
      ;;
  esac
  if [[ "$kind" == "raw" && -n "$requested_account" ]]; then
    die "--account is not supported for raw statements; the caller validates account coverage"
  fi

  query_count=$(jq -er --arg profile "$profile" \
    '(.profiles[$profile].flex.queries // {}) | length' "$profiles_json")
  if [[ -n "$requested_query" ]]; then
    jq -e --arg profile "$profile" --arg query "$requested_query" \
      '.profiles[$profile].flex.queries[$query] != null' "$profiles_json" >/dev/null \
      || die "no Flex query named $requested_query configured for profile $profile"
    query=$requested_query
  else
    case "$query_count" in
      0)
        die "no Flex queries configured for profile $profile"
        ;;
      1)
        query=$(jq -er --arg profile "$profile" \
          '.profiles[$profile].flex.queries | keys[0]' "$profiles_json")
        ;;
      *)
        die "multiple Flex queries configured for profile $profile; pass --flex-query"
        ;;
    esac
  fi

  query_id=$(jq -er --arg profile "$profile" --arg query "$query" \
    '.profiles[$profile].flex.queries[$query].queryId
      | select(type == "string" and length > 0)' "$profiles_json") \
    || die "Flex query ID is missing for query $query in profile $profile"
  token_ref=$(jq -er --arg profile "$profile" \
    '.profiles[$profile].flex.tokenRef // empty
      | select(type == "string" and length > 0)' "$profiles_json") \
    || token_ref=""
  token_file=$(jq -er --arg profile "$profile" \
    '.profiles[$profile].flex.tokenFile // empty
      | select(type == "string" and length > 0)' "$profiles_json") \
    || token_file=""
  if [[ -n "$token_ref" && -n "$token_file" ]]; then
    die "profile $profile configures both flex.tokenRef and flex.tokenFile; pick one"
  fi
  if [[ -z "$token_ref" && -z "$token_file" ]]; then
    die "Flex token reference is missing for profile $profile"
  fi
  if [[ -n "$token_ref" ]]; then
    [[ "$token_ref" == op://* ]] \
      || die "Flex token reference for profile $profile must use op://"
  else
    [[ "$token_file" == /* ]] \
      || die "Flex token file for profile $profile must be an absolute path"
  fi

  resolve_flex_dates "${date_args[@]}"

  if [[ -n "$token_ref" ]]; then
    command -v safe-op >/dev/null 2>&1 \
      || die "safe-op is required; refusing to read the Flex token with raw op"
  fi
  command -v ibkr-flex-fetch >/dev/null 2>&1 \
    || die "ibkr-flex-fetch is required"

  local token output
  if [[ -n "$token_file" ]]; then
    # A decrypted secret delivered as a file (e.g. sops-nix). The symlink chain is
    # followed, but the file itself must be owner-only before it is read.
    [[ -f "$token_file" ]] \
      || die "Flex token file is missing for profile $profile"
    local token_mode
    token_mode=$(stat -Lc '%a' "$token_file" 2>/dev/null) \
      || die "unable to inspect the Flex token file for profile $profile"
    case "$token_mode" in
      400|600) ;;
      *)
        die "Flex token file for profile $profile must be owner-only (mode 0400 or 0600)"
        ;;
    esac
    token=$(<"$token_file")
    if [[ -z "$token" ]]; then
      unset token
      die "Flex token file is empty for profile $profile"
    fi
  else
    if ! token=$(safe-op read "$token_ref" --no-newline 2>/dev/null); then
      token=""
      unset token
      die "unable to retrieve Flex token from 1Password for profile $profile"
    fi
    if [[ -z "$token" ]]; then
      unset token
      die "1Password returned an empty Flex token for profile $profile"
    fi
  fi

  local -a helper_args=(
    --query-id "$query_id"
    --kind "$kind"
  )
  if [[ -n "$requested_account" ]]; then
    helper_args+=(--account "$requested_account")
  fi
  helper_args+=(
    --from-date "$flex_from_date"
    --to-date "$flex_to_date"
  )

  if output=$(printf '%s' "$token" | ibkr-flex-fetch "${helper_args[@]}" 2>/dev/null); then
    token=""
    unset token
    printf '%s\n' "$output"
  else
    token=""
    unset token
    output=""
    unset output
    die "Flex history request failed for profile $profile"
  fi
}

cmd_config() {
  local sub=${1:-}
  case "$sub" in
    path)
      jq -n \
        --arg profiles "$profiles_json" \
        --arg xdg "$ibkr_xdg_home" \
        --arg upstream "$ibkr_xdg_home/ibkr-cli/config.toml" \
        '{profiles_json: $profiles, ibkr_xdg_config_home: $xdg, ibkr_cli_config: $upstream}'
      ;;
    show)
      require_config
      jq . "$profiles_json"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

cmd_gateway() {
  parse_common "$@"
  set -- "${remaining[@]}"
  require_config

  local gateway_dir jts_dir log_dir
  gateway_dir=$(profile_string "$profile" "gatewayDir" "$HOME/.local/share/ibkr/$profile/gateway")
  jts_dir=$(profile_string "$profile" "jtsConfigDir" "$HOME/.config/ibkr-local/jts/$profile")
  log_dir=$(profile_string "$profile" "logDir" "$state_home/ibkr-local/$profile")

  mkdir -p "$gateway_dir" "$jts_dir" "$log_dir"
  IBGATEWAY_DIR="$gateway_dir" IBGATEWAY_CONFIG_DIR="$jts_dir" IBGATEWAY_LOG_DIR="$log_dir" exec ibgateway "$@"
}

cmd_ibc_config() {
  require_config
  local profile="" username_ref="" password_ref="" username_item="" username_field="" username_vault="" password_item="" password_field="" password_vault="" trading_mode="" api_port="" second_factor_device="" auto_restart_time="" read_only_login=0 read_only_api=yes
  while (($#)); do
    case "$1" in
      -p|--profile)
        profile=$2
        shift 2
        ;;
      --username-ref)
        username_ref=$2
        shift 2
        ;;
      --username-item)
        username_item=$2
        shift 2
        ;;
      --username-field)
        username_field=$2
        shift 2
        ;;
      --username-vault)
        username_vault=$2
        shift 2
        ;;
      --password-ref)
        password_ref=$2
        shift 2
        ;;
      --password-item)
        password_item=$2
        shift 2
        ;;
      --password-field)
        password_field=$2
        shift 2
        ;;
      --password-vault)
        password_vault=$2
        shift 2
        ;;
      --trading-mode)
        trading_mode=$2
        shift 2
        ;;
      --api-port)
        api_port=$2
        shift 2
        ;;
      --second-factor-device)
        second_factor_device=$2
        shift 2
        ;;
      --auto-restart-time)
        auto_restart_time=$2
        shift 2
        ;;
      --read-only-login)
        read_only_login=1
        shift
        ;;
      --allow-api-write)
        read_only_api=no
        shift
        ;;
      *)
        die "unknown ibc-config option: $1"
        ;;
    esac
  done
  [[ -n "$profile" ]] || profile=$(default_profile)
  if [[ -z "$username_ref" ]]; then
    [[ -n "$username_item" ]] || die "--username-ref or --username-item is required"
    [[ -n "$username_field" ]] || die "--username-ref or --username-field is required"
    [[ -n "$username_vault" ]] || die "--username-ref or --username-vault is required"
    username_ref="op://$username_vault/$username_item/$username_field"
  fi
  if [[ -z "$password_ref" ]]; then
    [[ -n "$password_item" ]] || die "--password-ref or --password-item is required"
    [[ -n "$password_field" ]] || die "--password-ref or --password-field is required"
    [[ -n "$password_vault" ]] || die "--password-ref or --password-vault is required"
    password_ref="op://$password_vault/$password_item/$password_field"
  fi
  command -v safe-op >/dev/null 2>&1 || die "safe-op is required; refusing to read secrets with raw op"

  local runtime_parent runtime_dir config_path username password mode
  mode=${trading_mode:-$(profile_string "$profile" "mode" "paper")}
  api_port=${api_port:-$(profile_string "$profile" "port" "")}
  [[ "$api_port" =~ ^[0-9]+$ && "$api_port" -ge 1 && "$api_port" -le 65535 ]] \
    || die "profile API port must be an integer from 1 to 65535"
  runtime_parent=${IBKR_IBC_RUNTIME_PARENT:-${XDG_RUNTIME_DIR:-/tmp}}
  [[ -d "$runtime_parent" ]] || die "IBC runtime parent does not exist: $runtime_parent"

  username=$(safe-op read "$username_ref" --no-newline)
  password=$(safe-op read "$password_ref" --no-newline)
  [[ "$username" != *$'\n'* && "$username" != *$'\r'* ]] || die "username contains a line break"
  [[ "$password" != *$'\n'* && "$password" != *$'\r'* ]] || die "password contains a line break"
  [[ "$second_factor_device" != *$'\n'* && "$second_factor_device" != *$'\r'* ]] \
    || die "second-factor device contains a line break"
  if [[ -n "$auto_restart_time" ]]; then
    [[ "$auto_restart_time" =~ ^(0[1-9]|1[0-2]):[0-5][0-9]\ (AM|PM)$ ]] \
      || die "--auto-restart-time must use HH:MM AM/PM format"
  fi
  runtime_dir=$(mktemp -d "$runtime_parent/ibkr-ibc.XXXXXX")
  trap '[[ -z "${runtime_dir:-}" ]] || rm -rf -- "$runtime_dir"' EXIT
  chmod 700 "$runtime_dir"
  config_path="$runtime_dir/ibc.ini"
  umask 077
  {
    printf 'IbLoginId=%s\n' "$username"
    printf 'IbPassword=%s\n' "$password"
    printf 'TradingMode=%s\n' "$mode"
    printf 'ReadOnlyApi=%s\n' "$read_only_api"
    printf 'OverrideTwsApiPort=%s\n' "$api_port"
    if [[ "$read_only_login" == "1" ]]; then
      printf 'ReadOnlyLogin=yes\n'
    fi
    if [[ -n "$second_factor_device" ]]; then
      printf 'SecondFactorDevice=%s\n' "$second_factor_device"
    fi
    if [[ -n "$auto_restart_time" ]]; then
      printf 'AutoRestartTime=%s\n' "$auto_restart_time"
    fi
    printf 'ReloginAfterSecondFactorAuthenticationTimeout=no\n'
    printf 'SecondFactorAuthenticationExitInterval=60\n'
    printf 'ExistingSessionDetectedAction=primary\n'
    printf 'AcceptIncomingConnectionAction=reject\n'
  } > "$config_path"
  username=""
  password=""
  unset username password

  jq -n --arg config "$config_path" --arg runtime_dir "$runtime_dir" --arg read_only_login "$read_only_login" \
    '{config: $config, runtime_dir: $runtime_dir, read_only_login: ($read_only_login == "1"), note: "ephemeral IBC config written with mode 0600; delete runtime_dir after use"}'
  runtime_dir=""
  trap - EXIT
}

main() {
  local cmd=${1:-}
  [[ -n "$cmd" ]] || { usage; exit 2; }
  shift || true

  case "$cmd" in
    -h|--help|help)
      usage
      ;;
    config)
      cmd_config "$@"
      ;;
    doctor)
      parse_common "$@"; require_config
      run_ibkr_json "$profile" "$group" "$account" "$raw" 0 doctor
      ;;
    connect)
      parse_common "$@"; require_config
      run_ibkr_json "$profile" "$group" "$account" "$raw" 0 connect test
      ;;
    positions)
      parse_common "$@"; require_config
      run_ibkr_json "$profile" "$group" "$account" "$raw" 1 positions "${remaining[@]}"
      ;;
    balances)
      parse_common "$@"; require_config
      run_ibkr_json "$profile" "$group" "$account" "$raw" 1 account summary "${remaining[@]}"
      ;;
    executions)
      parse_common "$@"; require_config
      run_ibkr_json "$profile" "$group" "$account" "$raw" 1 orders executions "${remaining[@]}"
      ;;
    bars)
      parse_common "$@"; require_config
      set -- "${remaining[@]}"
      safe_args "$@"
      [[ $# -ge 1 ]] || die "bars requires a symbol"
      # Bars describe an instrument, not an account. --account and --group cannot narrow the
      # answer, so accepting them would silently imply a scoping that never happened; and the
      # payload carries no account field, so account filtering is skipped rather than run as a
      # no-op that would drop a row if upstream ever added one.
      [[ -z "$account" ]] || die "bars is not account-scoped; drop --account"
      [[ -z "$group" ]] || die "bars is not account-scoped; drop --group"
      run_ibkr_json "$profile" "" "" 1 0 bars "$@"
      ;;
    flex)
      parse_common "$@"; require_config
      run_flex "$profile" "$group" "$account" "${remaining[@]}"
      ;;
    order-prepare)
      cmd_order_prepare "$@"
      ;;
    order-submit)
      cmd_order_submit "$@"
      ;;
    order-cancel)
      cmd_order_cancel "$@"
      ;;
    order-preview)
      parse_common "$@"; require_config
      set -- "${remaining[@]}"
      safe_args "$@"
      local side=${1:-}
      [[ "$side" == "buy" || "$side" == "sell" ]] || die "order-preview requires buy or sell"
      shift
      local -a order_args
      order_args=("$side" "$@" --preview)
      if [[ -n "$account" ]]; then
        order_args+=(--account "$account")
      fi
      run_ibkr_json "$profile" "$group" "$account" "$raw" 0 "${order_args[@]}"
      ;;
    gateway)
      cmd_gateway "$@"
      ;;
    ibc-config)
      cmd_ibc_config "$@"
      ;;
    *)
      die "unknown command: $cmd"
      ;;
  esac
}

main "$@"
