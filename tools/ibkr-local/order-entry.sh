#!/usr/bin/env bash
#
# Fragment, not a standalone script: package.nix concatenates this ahead of
# ibkr-local.sh, which is where profiles_json, ibkr_xdg_home and state_home are
# assigned. writeShellApplication shellchecks the combined result, so those really are
# checked -- SC2154 only fires when this file is linted on its own.
# shellcheck disable=SC2154
#
# A downstream consumer places real orders through these guards against a written
# description of them, and deliberately pins no digest of this file: hashing tooling
# that updates out of band made every dependency bump look like a governance event.
# tests/test-order-entry.sh is therefore the only thing standing between a changed
# guard and a consumer that still believes the old one.
#
# Changing the command surface, the policy checks, the ticket lifecycle or the refusals
# below means updating that test in the same change, and saying so in the commit
# message loudly enough that the description downstream gets re-read.

order_policy_json() {
  local profile=$1
  jq -cer --arg profile "$profile" '
    .profiles[$profile] as $p
    | if $p == null then error("unknown profile") else $p end
    | {
        ibkrProfile: (.ibkrProfile // $profile),
        mode: (.mode // "paper"),
        orderEntry: {
          enable: (.orderEntry.enable // false),
          ticketTtlSeconds: (.orderEntry.ticketTtlSeconds // 120),
          allowedOrderTypes: (.orderEntry.allowedOrderTypes // ["LMT"]),
          allowOutsideRth: (.orderEntry.allowOutsideRth // false)
        }
      }
  ' "$profiles_json"
}

order_checksum() {
  jq -cS 'del(.checksum)' "$1" | sha256sum | cut -d' ' -f1
}

order_ticket_id() {
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
}

order_positive_number() {
  jq -en --arg value "$1" '$value | tonumber | . > 0' >/dev/null 2>&1
}

# Instrument selector. STK by ticker is the historical default and forwards nothing extra
# upstream; a BOND must name the instrument by conId or ISIN, because IBKR does not resolve
# bonds by ticker. CASH is a currency pair such as GBP.USD on IDEALPRO, named by the pair
# (and optionally --conid), never by ISIN. The upstream CLI re-validates (including the ISIN
# check digit) and refuses a resolved contract whose conId or secType differs.
order_validate_selector() {
  local sec_type=$1 con_id=$2 isin=$3
  [[ "$sec_type" == "STK" || "$sec_type" == "BOND" || "$sec_type" == "CASH" ]] \
    || die "unsupported --sec-type: $sec_type (use STK, BOND or CASH)"
  [[ -z "$con_id" || "$con_id" =~ ^[1-9][0-9]*$ ]] || die "--conid must be a positive integer"
  [[ -z "$isin" || "$isin" =~ ^[A-Z]{2}[A-Z0-9]{9}[0-9]$ ]] || die "--isin is not a valid ISIN: $isin"
  if [[ "$sec_type" == "CASH" ]]; then
    [[ -z "$isin" ]] || die "CASH orders are named by currency pair, not --isin"
  elif [[ "$sec_type" != "STK" && -z "$con_id" && -z "$isin" ]]; then
    die "$sec_type orders require --conid or --isin"
  fi
}

# Currency conversion (CASH) is a slippage-capped marketable limit order. The caller never
# chooses the price: the guard reads a fresh MIDPOINT reference rate, derives the capped
# limit from it, and records the whole band in the ticket so order-submit can re-check it.
readonly ORDER_FX_EXCHANGE=IDEALPRO
readonly ORDER_FX_DEFAULT_BPS=20
readonly ORDER_FX_MAX_BPS=50
readonly ORDER_FX_MAX_REFERENCE_AGE_SECONDS=900

# Prints the capped limit for SIDE: BUY rounds ref*(1+bps) DOWN to the tick, SELL rounds
# ref*(1-bps) UP, so rounding can only tighten the band, never widen it. The printed
# decimals are the tick's own decimal places (0.0025 -> 4, 5e-05 -> 5), not
# ceil(-log10(tick)), which would re-round a 2.5x10^k tick off the grid and past the cap.
# Fails, printing nothing, if the tick has no short decimal form or the printed value is
# off the grid or beyond the cap.
order_fx_capped_limit() {
  local side=$1 ref=$2 bps=$3 tick=$4
  awk -v side="$side" -v ref="$ref" -v bps="$bps" -v tick="$tick" 'BEGIN {
    for (dec = 0; dec <= 12; dec++) {
      s = tick * 10 ^ dec; r = int(s + 0.5)
      if (r >= 1 && s - r < 1e-6 && r - s < 1e-6) break
    }
    if (dec > 12) exit 1
    cap = (side == "BUY") ? ref * (1 + bps / 10000) : ref * (1 - bps / 10000)
    x = cap / tick
    if (side == "BUY") n = int(x + 1e-9)
    else { n = int(x); if (n < x - 1e-9) n++ }
    out = sprintf("%.*f", dec, n * tick)
    q = out / tick
    if (q - n > 1e-6 || n - q > 1e-6) exit 1
    if (side == "BUY" && out + 0 > cap + 1e-12) exit 1
    if (side != "BUY" && out + 0 < cap - 1e-12) exit 1
    print out
  }'
}

# Succeeds when LIMIT is on the tick grid and inside [LOW, HIGH].
order_fx_limit_in_band() {
  local limit=$1 low=$2 high=$3 tick=$4
  awk -v l="$limit" -v lo="$low" -v hi="$high" -v tick="$tick" 'BEGIN {
    x = l / tick; n = int(x + 0.5)
    exit !((x - n < 1e-6 && n - x < 1e-6) && l >= lo - 1e-12 && l <= hi + 1e-12)
  }'
}

cmd_order_prepare() {
  require_config

  local side=${1:-} symbol=${2:-} quantity=${3:-}
  (($# >= 3)) || die "order-prepare requires buy|sell SYMBOL QUANTITY"
  shift 3

  [[ "$side" == "buy" || "$side" == "sell" ]] || die "order-prepare requires buy or sell"
  [[ -n "$symbol" ]] || die "order-prepare requires a symbol"
  order_positive_number "$quantity" || die "order quantity must be positive"

  local profile="" account="" order_type="LMT" limit_price=""
  local exchange="SMART" currency="USD" tif="DAY" outside_rth=0
  local sec_type="STK" con_id="" isin="" max_slippage_bps=""
  local exchange_set=0 currency_set=0
  while (($#)); do
    case "$1" in
      -p|--profile)
        (($# >= 2)) || die "$1 requires a value"
        profile=$2
        shift 2
        ;;
      --account)
        (($# >= 2)) || die "$1 requires a value"
        account=$2
        shift 2
        ;;
      --type)
        (($# >= 2)) || die "$1 requires a value"
        order_type=$2
        shift 2
        ;;
      --limit)
        (($# >= 2)) || die "$1 requires a value"
        limit_price=$2
        shift 2
        ;;
      --exchange)
        (($# >= 2)) || die "$1 requires a value"
        exchange=$2
        exchange_set=1
        shift 2
        ;;
      --currency)
        (($# >= 2)) || die "$1 requires a value"
        currency=$2
        currency_set=1
        shift 2
        ;;
      --max-slippage-bps)
        (($# >= 2)) || die "$1 requires a value"
        max_slippage_bps=$2
        shift 2
        ;;
      --sec-type)
        (($# >= 2)) || die "$1 requires a value"
        sec_type=${2^^}
        shift 2
        ;;
      --conid)
        (($# >= 2)) || die "$1 requires a value"
        con_id=$2
        shift 2
        ;;
      --isin)
        (($# >= 2)) || die "$1 requires a value"
        isin=${2^^}
        shift 2
        ;;
      --tif)
        (($# >= 2)) || die "$1 requires a value"
        tif=$2
        shift 2
        ;;
      --outside-rth)
        outside_rth=1
        shift
        ;;
      --json)
        shift
        ;;
      *)
        die "unknown order-prepare option: $1"
        ;;
    esac
  done

  [[ -n "$profile" ]] || die "order-prepare requires explicit --profile"
  [[ -n "$account" ]] || die "order-prepare requires explicit --account"
  [[ "$order_type" == "LMT" ]] || die "guarded order entry currently permits only LMT orders"
  [[ "$tif" == "DAY" ]] || die "guarded order entry currently permits only DAY orders"
  # FX on IDEALPRO trades around the clock on weekdays and has no RTH session, so a CASH
  # order never needs --outside-rth: it stays refused for every security type.
  [[ "$outside_rth" == "0" ]] || die "guarded order entry currently blocks outside-RTH orders"
  local fx_base="" fx_quote=""
  if [[ "$sec_type" == "CASH" ]]; then
    # USD.GBP does not exist at IBKR: USD->GBP is BUY GBP.USD, quantity in the base currency.
    symbol=${symbol^^}
    [[ "$symbol" =~ ^([A-Z]{3})\.([A-Z]{3})$ ]] \
      || die "CASH orders need a currency pair such as GBP.USD, not: $symbol"
    fx_base=${BASH_REMATCH[1]}
    fx_quote=${BASH_REMATCH[2]}
    [[ "$fx_base" != "$fx_quote" ]] || die "not a currency pair: $symbol"
    [[ "$currency_set" == "0" || "${currency^^}" == "$fx_quote" ]] \
      || die "--currency must be the quote currency of $symbol ($fx_quote)"
    currency=$fx_quote
    [[ "$exchange_set" == "0" || "${exchange^^}" == "$ORDER_FX_EXCHANGE" ]] \
      || die "CASH orders trade only on $ORDER_FX_EXCHANGE"
    exchange=$ORDER_FX_EXCHANGE
    [[ "$quantity" =~ ^[0-9]+(\.[0-9]{0,2}0*)?$ ]] \
      || die "CASH quantity must be a multiple of 0.01 of $fx_base: $quantity"
    max_slippage_bps=${max_slippage_bps:-$ORDER_FX_DEFAULT_BPS}
    if [[ ! "$max_slippage_bps" =~ ^[1-9][0-9]{0,2}$ ]] || ((max_slippage_bps > ORDER_FX_MAX_BPS)); then
      die "--max-slippage-bps must be an integer from 1 to $ORDER_FX_MAX_BPS"
    fi
    [[ -z "$limit_price" ]] || order_positive_number "$limit_price" || die "limit price must be positive"
  else
    [[ -z "$max_slippage_bps" ]] || die "--max-slippage-bps applies only to --sec-type CASH"
    [[ -n "$limit_price" ]] || die "LMT orders require --limit"
    order_positive_number "$limit_price" || die "limit price must be positive"
  fi
  order_validate_selector "$sec_type" "$con_id" "$isin"

  local -a selector_args=()
  if [[ "$sec_type" != "STK" || -n "$con_id" || -n "$isin" ]]; then
    selector_args+=(--sec-type "$sec_type")
    [[ -z "$con_id" ]] || selector_args+=(--conid "$con_id")
    [[ -z "$isin" ]] || selector_args+=(--isin "$isin")
  fi

  local policy
  if ! policy=$(order_policy_json "$profile"); then
    die "unknown profile: $profile"
  fi
  [[ "$(jq -r '.orderEntry.enable' <<<"$policy")" == "true" ]] \
    || die "order entry is disabled for profile: $profile"
  jq -e --arg order_type "$order_type" '.orderEntry.allowedOrderTypes | index($order_type) != null' \
    <<<"$policy" >/dev/null || die "order type is not enabled for profile: $profile"

  local ibkr_profile mode ttl preview preview_output
  ibkr_profile=$(jq -r '.ibkrProfile' <<<"$policy")
  mode=$(jq -r '.mode' <<<"$policy")
  ttl=$(jq -r '.orderEntry.ticketTtlSeconds' <<<"$policy")

  local fx_json=null
  if [[ "$sec_type" == "CASH" ]]; then
    local ref_output ref ref_con_id ref_rate ref_time ref_epoch min_tick now_epoch
    local band_low band_high capped limit_source=derived
    if ! ref_output=$(
      XDG_CONFIG_HOME="$ibkr_xdg_home" "$IBKR_UPSTREAM" \
        bars "$symbol" --profile "$ibkr_profile" \
        --exchange "$exchange" --currency "$currency" \
        "${selector_args[@]}" \
        --duration "1800 S" --bar-size "1 min" --what-to-show MIDPOINT --all-hours --json
    ); then
      printf '%s\n' "$ref_output" >&2
      die "could not read a reference rate for $symbol"
    fi
    ref=$(order_response_json "$ref_output")
    jq -e --arg con_id "$con_id" --arg base "$fx_base" --arg quote "$fx_quote" '
      .sec_type == "CASH"
      and (.con_id | type == "number" and . > 0)
      and ($con_id == "" or .con_id == ($con_id | tonumber))
      and .symbol == $base and .currency == $quote
      and .what_to_show == "MIDPOINT"
      and (.min_tick | type == "number" and . > 0)
      and (.rows | type == "array" and length > 0)
      and (.rows | max_by(.date) | .close | type == "number" and . > 0)
    ' <<<"$ref" >/dev/null \
      || die "IBKR returned no usable MIDPOINT reference rate for $symbol"
    ref_con_id=$(jq -r '.con_id' <<<"$ref")
    min_tick=$(jq -r '.min_tick' <<<"$ref")
    ref_rate=$(jq -r '.rows | max_by(.date) | .close' <<<"$ref")
    ref_time=$(jq -r '.rows | max_by(.date) | .date' <<<"$ref")
    ref_epoch=$(date -d "$ref_time" +%s 2>/dev/null) \
      || die "unreadable reference bar time for $symbol: $ref_time"
    now_epoch=$(date +%s)
    # FX is shut at weekends and the last bar is then Friday's: refuse, never fill a stale rate.
    ((now_epoch - ref_epoch <= ORDER_FX_MAX_REFERENCE_AGE_SECONDS)) \
      || die "reference rate for $symbol is stale (bar at $ref_time); FX may be closed"
    ((ref_epoch - now_epoch <= 60)) || die "reference bar for $symbol is in the future: $ref_time"

    capped=$(order_fx_capped_limit "${side^^}" "$ref_rate" "$max_slippage_bps" "$min_tick") \
      || die "could not derive a $max_slippage_bps bp limit on the $min_tick tick from $ref_rate"
    if [[ "${side^^}" == "BUY" ]]; then
      band_low=$ref_rate
      band_high=$capped
    else
      band_low=$capped
      band_high=$ref_rate
    fi
    jq -en --argjson low "$band_low" --argjson high "$band_high" '$low <= $high' >/dev/null \
      || die "a $max_slippage_bps bp band around $ref_rate is narrower than one tick ($min_tick)"
    if [[ -n "$limit_price" ]]; then
      order_fx_limit_in_band "$limit_price" "$band_low" "$band_high" "$min_tick" \
        || die "--limit $limit_price is outside the $max_slippage_bps bp band [$band_low, $band_high] or off the $min_tick tick"
      limit_source=caller
    else
      limit_price=$capped
    fi
    # Pin the preview, the ticket and the submission to the conId whose rate was read.
    con_id=$ref_con_id
    selector_args=(--sec-type CASH --conid "$con_id")
    fx_json=$(jq -cn \
      --arg pair "$symbol" \
      --argjson reference_rate "$ref_rate" \
      --arg reference_time "$ref_time" \
      --argjson reference_epoch "$ref_epoch" \
      --argjson max_slippage_bps "$max_slippage_bps" \
      --argjson min_tick "$min_tick" \
      --argjson band_low "$band_low" \
      --argjson band_high "$band_high" \
      --arg limit_source "$limit_source" '
        {
          pair: $pair,
          referenceRate: $reference_rate,
          referenceSource: "MIDPOINT",
          referenceTime: $reference_time,
          referenceEpoch: $reference_epoch,
          maxSlippageBps: $max_slippage_bps,
          minTick: $min_tick,
          bandLow: $band_low,
          bandHigh: $band_high,
          limitSource: $limit_source
        }
      ')
  fi

  if ! preview_output=$(
    XDG_CONFIG_HOME="$ibkr_xdg_home" "$IBKR_UPSTREAM" \
      "$side" "$symbol" "$quantity" \
      --profile "$ibkr_profile" --account "$account" \
      --exchange "$exchange" --currency "$currency" \
      "${selector_args[@]}" \
      --type "$order_type" --limit "$limit_price" --tif "$tif" \
      --preview --json
  ); then
    printf '%s\n' "$preview_output" >&2
    return 1
  fi

  preview=$(order_response_json "$preview_output")
  [[ "$preview" != "null" ]] || die "IBKR preview returned invalid JSON"

  jq -e --arg account "$account" '
    .preview_only == true and .selected_account == $account
  ' <<<"$preview" >/dev/null \
    || die "IBKR preview did not confirm the requested account"
  jq -e --arg sec_type "$sec_type" --arg con_id "$con_id" --arg isin "$isin" '
    .sec_type == $sec_type
    and (.con_id | type == "number" and . > 0)
    and ($con_id == "" or .con_id == ($con_id | tonumber))
    and ($isin == "" or .isin == $isin)
  ' <<<"$preview" >/dev/null \
    || die "IBKR preview did not confirm the requested instrument"
  if [[ "$sec_type" == "CASH" ]]; then
    jq -e --arg base "$fx_base" --arg quote "$fx_quote" '.symbol == $base and .currency == $quote' \
      <<<"$preview" >/dev/null || die "IBKR preview did not confirm the currency pair $symbol"
  fi

  local ticket_root prepared_dir claimed_dir ticket_id created_at expires_at
  local tmp final_tmp checksum ticket
  ticket_root="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/ibkr-local/order-tickets"
  prepared_dir="$ticket_root/prepared"
  claimed_dir="$ticket_root/claimed"
  umask 077
  mkdir -p "$prepared_dir" "$claimed_dir"
  chmod 700 "$ticket_root" "$prepared_dir" "$claimed_dir"

  ticket_id=$(order_ticket_id)
  created_at=$(date +%s)
  expires_at=$((created_at + ttl))
  ticket="$prepared_dir/$ticket_id.json"
  tmp=$(mktemp "$prepared_dir/.ticket.XXXXXX")
  final_tmp=$(mktemp "$prepared_dir/.ticket-final.XXXXXX")

  jq -n \
    --argjson schema_version 1 \
    --arg ticket_id "$ticket_id" \
    --argjson created_at "$created_at" \
    --argjson expires_at "$expires_at" \
    --arg profile "$profile" \
    --arg ibkr_profile "$ibkr_profile" \
    --arg mode "$mode" \
    --arg account "$account" \
    --arg action "${side^^}" \
    --arg symbol "$symbol" \
    --arg quantity "$quantity" \
    --arg exchange "$exchange" \
    --arg currency "$currency" \
    --arg sec_type "$sec_type" \
    --arg con_id "$con_id" \
    --arg isin "$isin" \
    --arg order_type "$order_type" \
    --arg limit_price "$limit_price" \
    --arg tif "$tif" \
    --argjson fx "$fx_json" \
    --argjson preview "$preview" '
      {
        schemaVersion: $schema_version,
        ticketId: $ticket_id,
        createdAt: $created_at,
        expiresAt: $expires_at,
        profile: $profile,
        ibkrProfile: $ibkr_profile,
        mode: $mode,
        account: $account,
        order: {
          action: $action,
          symbol: $symbol,
          quantity: ($quantity | tonumber),
          exchange: $exchange,
          currency: $currency,
          secType: $sec_type,
          conId: (if $con_id == "" then null else ($con_id | tonumber) end),
          isin: (if $isin == "" then null else $isin end),
          orderType: $order_type,
          limitPrice: ($limit_price | tonumber),
          tif: $tif,
          outsideRth: false
        } + (if $fx == null then {} else {fx: $fx} end),
        contract: {
          symbol: $preview.symbol,
          localSymbol: $preview.local_symbol,
          exchange: $preview.exchange,
          primaryExchange: $preview.primary_exchange,
          currency: $preview.currency,
          secType: $preview.sec_type,
          conId: $preview.con_id,
          description: ($preview.description // null),
          isin: ($preview.isin // null)
        },
        preview: {
          previewOnly: $preview.preview_only,
          status: $preview.status,
          commission: $preview.commission,
          minCommission: $preview.min_commission,
          maxCommission: $preview.max_commission,
          commissionCurrency: $preview.commission_currency,
          initMarginChange: $preview.init_margin_change,
          maintMarginChange: $preview.maint_margin_change,
          equityWithLoanChange: $preview.equity_with_loan_change,
          warningText: $preview.warning_text,
          rawErrorCodes: ($preview.raw_error_codes // [])
        }
      }
    ' >"$tmp"

  checksum=$(order_checksum "$tmp")
  jq --arg checksum "$checksum" '. + {checksum: $checksum}' "$tmp" >"$final_tmp"
  chmod 600 "$final_tmp"
  mv "$final_tmp" "$ticket"
  rm -f "$tmp"
  cat "$ticket"
}

order_write_audit() {
  local path=$1 state=$2 response=$3 exit_status=$4
  local tmp="$path.tmp.$$" updated_at
  updated_at=$(date +%s)
  jq \
    --arg state "$state" \
    --argjson response "$response" \
    --argjson exit_status "$exit_status" \
    --argjson updated_at "$updated_at" '
      . + {
        state: $state,
        updatedAt: $updated_at,
        brokerExitStatus: $exit_status,
        brokerResponse: $response
      }
    ' "$path" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$path"
}

order_response_json() {
  local output=$1
  local payload
  payload=$(awk 'found || /^[[:space:]]*\{/ { found=1; print }' <<<"$output")
  if jq -e 'type == "object"' <<<"$payload" >/dev/null 2>&1; then
    jq -c . <<<"$payload"
  else
    printf 'null\n'
  fi
}

order_finish_mutation() {
  local audit=$1 exit_status=$2 output=$3 operation=$4
  local response state
  response=$(order_response_json "$output")

  if [[ "$exit_status" == "0" && "$response" != "null" ]]; then
    state="submitted"
  elif [[ "$exit_status" != "0" && "$response" != "null" ]]; then
    state="rejected"
  else
    state="attempted-unknown"
  fi

  order_write_audit "$audit" "$state" "$response" "$exit_status"
  if [[ "$state" == "submitted" ]]; then
    cat "$audit"
    return 0
  fi

  if [[ "$state" == "rejected" ]]; then
    printf '%s: broker rejected %s; inspect %s\n' "$APP_NAME" "$operation" "$audit" >&2
  else
    printf '%s: %s result is unknown; inspect orders before retrying; audit: %s\n' \
      "$APP_NAME" "$operation" "$audit" >&2
  fi
  return 1
}

order_validate_ticket() {
  local ticket=$1 ticket_id=$2 confirm=$3
  local checksum expected now profile policy

  [[ "$confirm" == "$ticket_id" ]] || die "order-submit confirmation must match the ticket id"
  [[ -f "$ticket" && ! -L "$ticket" ]] || die "prepared order ticket not found: $ticket_id"
  jq -e --arg ticket_id "$ticket_id" '
    .schemaVersion == 1
    and .ticketId == $ticket_id
    and (.profile | type == "string" and length > 0)
    and (.ibkrProfile | type == "string" and length > 0)
    and (.account | type == "string" and length > 0)
    and (.order.action == "BUY" or .order.action == "SELL")
    and .order.orderType == "LMT"
    and .order.tif == "DAY"
    and .order.outsideRth == false
    and (.order.quantity | type == "number" and . > 0)
    and (.order.limitPrice | type == "number" and . > 0)
    and ((.order.secType // "STK") as $sec_type
      | if $sec_type == "CASH" then
          # A currency conversion must still be the pair, conId and slippage band that were
          # previewed: the limit has to sit inside the recorded band, and the band inside
          # the recorded cap around the recorded reference rate.
          .order.fx as $fx
          | ($fx | type == "object")
          and ($fx.pair | type == "string" and test("^[A-Z]{3}\\.[A-Z]{3}$"))
          and .order.symbol == $fx.pair
          and .order.exchange == "IDEALPRO"
          and .order.currency == ($fx.pair | split(".")[1])
          and .order.isin == null
          and .contract.secType == "CASH"
          and (.contract.conId | type == "number" and . > 0)
          and .order.conId == .contract.conId
          and .contract.symbol == ($fx.pair | split(".")[0])
          and .contract.currency == .order.currency
          and ((.order.quantity * 100) as $q | ($q - ($q | round)) | fabs < 1e-6)
          and ($fx.maxSlippageBps | type == "number" and . == floor and . >= 1 and . <= 50)
          and ($fx.referenceRate | type == "number" and . > 0)
          and ($fx.minTick | type == "number" and . > 0)
          and ($fx.bandLow | type == "number") and ($fx.bandHigh | type == "number")
          and (if .order.action == "BUY" then
                 $fx.bandLow == $fx.referenceRate
                 and $fx.bandHigh >= $fx.bandLow
                 and $fx.bandHigh <= $fx.referenceRate * (1 + $fx.maxSlippageBps / 10000) + 1e-12
               else
                 $fx.bandHigh == $fx.referenceRate
                 and $fx.bandLow <= $fx.bandHigh
                 and $fx.bandLow >= $fx.referenceRate * (1 - $fx.maxSlippageBps / 10000) - 1e-12
               end)
          and .order.limitPrice >= $fx.bandLow and .order.limitPrice <= $fx.bandHigh
          and ((.order.limitPrice / $fx.minTick) as $n | ($n - ($n | round)) | fabs < 1e-6)
        else
          ($sec_type == "STK" or $sec_type == "BOND")
          and .order.fx == null
          and (($sec_type == "STK" and .order.conId == null and .order.isin == null)
            or (.contract.secType == $sec_type
              and (.contract.conId | type == "number" and . > 0)
              and (.order.conId == null or .order.conId == .contract.conId)))
        end)
  ' "$ticket" >/dev/null || die "prepared order ticket is malformed"

  checksum=$(jq -er '.checksum' "$ticket")
  expected=$(order_checksum "$ticket")
  [[ "$checksum" == "$expected" ]] || die "prepared order ticket checksum mismatch"

  now=$(date +%s)
  [[ "$(jq -r '.expiresAt' "$ticket")" -ge "$now" ]] || die "prepared order ticket has expired"

  profile=$(jq -r '.profile' "$ticket")
  if ! policy=$(order_policy_json "$profile"); then
    die "unknown profile in prepared order ticket: $profile"
  fi
  [[ "$(jq -r '.orderEntry.enable' <<<"$policy")" == "true" ]] \
    || die "order entry is disabled for profile: $profile"
  jq -e --arg order_type "$(jq -r '.order.orderType' "$ticket")" '
    .orderEntry.allowedOrderTypes | index($order_type) != null
  ' <<<"$policy" >/dev/null || die "ticket order type is no longer enabled"
  [[ "$(jq -r '.ibkrProfile' <<<"$policy")" == "$(jq -r '.ibkrProfile' "$ticket")" ]] \
    || die "ticket upstream profile no longer matches configuration"
  [[ "$(jq -r '.mode' <<<"$policy")" == "$(jq -r '.mode' "$ticket")" ]] \
    || die "ticket trading mode no longer matches configuration"
}

cmd_order_submit() {
  require_config

  local ticket_id=${1:-} confirm=""
  [[ "$ticket_id" =~ ^[0-9a-f]{32}$ ]] || die "order-submit requires a valid ticket id"
  shift
  while (($#)); do
    case "$1" in
      --confirm)
        (($# >= 2)) || die "$1 requires a value"
        confirm=$2
        shift 2
        ;;
      --json)
        shift
        ;;
      *)
        die "unknown order-submit option: $1"
        ;;
    esac
  done

  local ticket_root prepared claimed audit_dir audit tmp
  ticket_root="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/ibkr-local/order-tickets"
  prepared="$ticket_root/prepared/$ticket_id.json"
  claimed="$ticket_root/claimed/$ticket_id.json"
  order_validate_ticket "$prepared" "$ticket_id" "$confirm"

  mkdir -p "$ticket_root/claimed"
  chmod 700 "$ticket_root" "$ticket_root/claimed"
  if ! mv "$prepared" "$claimed" 2>/dev/null; then
    die "prepared order ticket was already consumed: $ticket_id"
  fi

  audit_dir="${state_home}/ibkr-local/orders"
  umask 077
  mkdir -p "$audit_dir"
  chmod 700 "${state_home}/ibkr-local" "$audit_dir"
  audit="$audit_dir/$ticket_id.json"
  tmp=$(mktemp "$audit_dir/.audit.XXXXXX")
  jq --argjson updated_at "$(date +%s)" \
    '. + {state: "submitting", updatedAt: $updated_at, brokerResponse: null}' \
    "$claimed" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$audit"

  local action symbol quantity ibkr_profile account exchange currency order_type limit_price tif
  action=$(jq -r '.order.action | ascii_downcase' "$claimed")
  symbol=$(jq -r '.order.symbol' "$claimed")
  quantity=$(jq -r '.order.quantity' "$claimed")
  ibkr_profile=$(jq -r '.ibkrProfile' "$claimed")
  account=$(jq -r '.account' "$claimed")
  exchange=$(jq -r '.order.exchange' "$claimed")
  currency=$(jq -r '.order.currency' "$claimed")
  order_type=$(jq -r '.order.orderType' "$claimed")
  limit_price=$(jq -r '.order.limitPrice' "$claimed")
  tif=$(jq -r '.order.tif' "$claimed")

  # An identifier-based ticket is submitted by the conId its preview resolved, so the order
  # can only reach the exact instrument the owner saw previewed. A plain STK ticker ticket
  # is submitted exactly as before.
  local -a selector_args=()
  if jq -e '(.order.secType // "STK") != "STK" or .order.conId != null or .order.isin != null' \
    "$claimed" >/dev/null; then
    selector_args=(
      --sec-type "$(jq -r '.order.secType' "$claimed")"
      --conid "$(jq -r '.contract.conId' "$claimed")"
    )
  fi

  local output exit_status
  set +e
  output=$(
    XDG_CONFIG_HOME="$ibkr_xdg_home" "$IBKR_UPSTREAM" \
      "$action" "$symbol" "$quantity" \
      --profile "$ibkr_profile" --account "$account" \
      --exchange "$exchange" --currency "$currency" \
      "${selector_args[@]}" \
      --type "$order_type" --limit "$limit_price" --tif "$tif" \
      --submit --json 2>&1
  )
  exit_status=$?
  set -e

  order_finish_mutation "$audit" "$exit_status" "$output" "order submission"
}

cmd_order_cancel() {
  require_config

  local order_id=${1:-} profile="" account="" confirm=""
  [[ "$order_id" =~ ^[0-9]+$ ]] || die "order-cancel requires a numeric order id"
  shift
  while (($#)); do
    case "$1" in
      -p|--profile)
        (($# >= 2)) || die "$1 requires a value"
        profile=$2
        shift 2
        ;;
      --account)
        (($# >= 2)) || die "$1 requires a value"
        account=$2
        shift 2
        ;;
      --confirm)
        (($# >= 2)) || die "$1 requires a value"
        confirm=$2
        shift 2
        ;;
      --json)
        shift
        ;;
      *)
        die "unknown order-cancel option: $1"
        ;;
    esac
  done

  [[ -n "$profile" ]] || die "order-cancel requires explicit --profile"
  [[ -n "$account" ]] || die "order-cancel requires explicit --account"
  [[ "$confirm" == "$order_id" ]] || die "order-cancel confirmation must match the order id"

  local policy ibkr_profile audit_id audit_dir audit tmp created_at
  if ! policy=$(order_policy_json "$profile"); then
    die "unknown profile: $profile"
  fi
  [[ "$(jq -r '.orderEntry.enable' <<<"$policy")" == "true" ]] \
    || die "order entry is disabled for profile: $profile"
  ibkr_profile=$(jq -r '.ibkrProfile' <<<"$policy")

  audit_id="cancel-$(order_ticket_id)"
  audit_dir="${state_home}/ibkr-local/orders"
  umask 077
  mkdir -p "$audit_dir"
  chmod 700 "${state_home}/ibkr-local" "$audit_dir"
  audit="$audit_dir/$audit_id.json"
  tmp=$(mktemp "$audit_dir/.audit.XXXXXX")
  created_at=$(date +%s)
  jq -n \
    --argjson schema_version 1 \
    --arg audit_id "$audit_id" \
    --argjson created_at "$created_at" \
    --arg profile "$profile" \
    --arg ibkr_profile "$ibkr_profile" \
    --arg account "$account" \
    --arg order_id "$order_id" '
      {
        schemaVersion: $schema_version,
        auditId: $audit_id,
        createdAt: $created_at,
        updatedAt: $created_at,
        state: "submitting",
        profile: $profile,
        ibkrProfile: $ibkr_profile,
        account: $account,
        cancellation: {orderId: ($order_id | tonumber)},
        brokerResponse: null
      }
    ' >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$audit"

  local output exit_status
  set +e
  output=$(
    XDG_CONFIG_HOME="$ibkr_xdg_home" "$IBKR_UPSTREAM" \
      orders cancel "$order_id" \
      --profile "$ibkr_profile" --account "$account" --json 2>&1
  )
  exit_status=$?
  set -e

  order_finish_mutation "$audit" "$exit_status" "$output" "order cancellation"
}
