#!/usr/bin/env bash

# bdw -- one Claude Code session per bead, harvested back onto the bead.
#
# The bead is the durable record. Everything bdw needs to resurrect a session
# lives in the bead's metadata (bdw_session, bdw_tmux, bdw_cwd, bdw_host) and
# its notes (the handoff blocks). The state directory is a launch cache and a
# reverse index; deleting it loses nothing that `bd show` cannot rebuild.

state_dir=${BDW_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/bdw}
self=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")

# Marker written into the notes field. `bdw start` reads back the last one to
# prime a session whose transcript is gone.
handoff_marker='## bdw handoff'

die() {
  printf 'bdw: %s\n' "$1" >&2
  exit "${2:-1}"
}

usage() {
  cat >&2 <<'EOF'
bdw -- one Claude Code session per bead

  bdw start <bead-id>       claim the bead, open its tmux session, prime Claude
            [--dry-run]     ...or just say what that would do, changing nothing
  bdw attach <bead-id>      switch to (or attach) that bead's tmux session
  bdw ls [--human]          beads with a bdw session, joined to live state
  bdw finish <bead-id>      harvest conclusions onto the bead now
            [--close]       ...and close the bead
  bdw hook                  SessionEnd hook entrypoint; reads hook JSON on stdin

Resume is automatic: `bdw start` on a bead that already has a session resumes
it, and falls back to the last handoff block in the bead's notes when the
transcript is gone or lives on another host.
EOF
  exit 2
}

# tmux rejects '.' and ':' in session names -- they are target separators.
# work-ysf.6 therefore becomes bd-work-ysf-6. The mapping is one-way, which is
# why the real name is stored in bdw_tmux rather than recomputed.
tmux_name() {
  printf 'bd-%s' "${1//[.:]/-}"
}

bead_json() {
  bd show "$1" --json 2>/dev/null | jq -e '.[0] // empty' 2>/dev/null
}

meta() {
  # meta <bead-json> <key>
  jq -r --arg k "$2" '.metadata[$k] // ""' <<<"$1"
}

# Everything a fresh session needs to pick the work up cold.
prime_prompt() {
  local bead=$1 handoff=$2
  {
    printf 'You are working bead %s in this repository.\n\n' "$(jq -r .id <<<"$bead")"
    printf '# %s\n\n' "$(jq -r .title <<<"$bead")"
    local desc design notes
    desc=$(jq -r '.description // ""' <<<"$bead")
    design=$(jq -r '.design // ""' <<<"$bead")
    notes=$(jq -r '.notes // ""' <<<"$bead")
    if [ -n "$desc" ]; then printf '## Description\n%s\n\n' "$desc"; fi
    if [ -n "$design" ]; then printf '## Design\n%s\n\n' "$design"; fi
    if [ -n "$notes" ]; then printf '## Notes so far\n%s\n\n' "$notes"; fi
    if [ -n "$handoff" ]; then
      printf '## Where the last session left off\n%s\n\n' "$handoff"
      printf 'That session is gone; you are continuing from the handoff above.\n\n'
    fi
    printf 'Start by telling me your plan for this bead. Do not close it yourself --\n'
    printf 'bdw harvests your conclusions onto the bead when the session ends.\n'
  } | sed -e 's/[[:space:]]*$//'
}

# The most recent handoff block from the notes field, or empty.
last_handoff() {
  jq -r '.notes // ""' <<<"$1" |
    awk -v m="$handoff_marker" '
      index($0, m) == 1 { buf = ""; found = 1; next }
      found { buf = buf $0 "\n" }
      END { printf "%s", buf }
    '
}

cmd_start() {
  # --dry-run exists because `start` is destructive on sight: it claims the bead,
  # labels it and launches a session. Testing the completion by pressing TAB and
  # Enter should not be able to do that by accident.
  local id='' dry=''
  local arg
  for arg in "$@"; do
    case $arg in
      --dry-run) dry=1 ;;
      *) [ -n "$id" ] || id=$arg ;;
    esac
  done
  [ -n "$id" ] || usage

  local bead
  bead=$(bead_json "$id") || die "no bead matching '$id'"
  id=$(jq -r .id <<<"$bead")

  local sess uuid cwd host mode
  sess=$(meta "$bead" bdw_tmux)
  uuid=$(meta "$bead" bdw_session)
  cwd=$(meta "$bead" bdw_cwd)
  host=$(meta "$bead" bdw_host)
  [ -n "$sess" ] || sess=$(tmux_name "$id")
  [ -n "$cwd" ] && [ -d "$cwd" ] || cwd=$PWD

  # A live tmux session means the work is already open; just go there.
  if [ -z "$dry" ] && tmux has-session -t "=$sess" 2>/dev/null; then
    printf 'bdw: %s is already running in tmux session %s\n' "$id" "$sess" >&2
    attach_to "$sess"
    return
  fi

  # Resume only what this host can actually resume: transcripts are local.
  local handoff=''
  if [ -n "$uuid" ] && [ "$host" = "$(uname -n)" ]; then
    mode=resume
  else
    mode=fresh
    if [ -n "$uuid" ]; then handoff=$(last_handoff "$bead"); fi
    uuid=$(cat /proc/sys/kernel/random/uuid)
  fi

  if [ -n "$dry" ]; then
    printf 'bdw: would %s %s\n' "$mode" "$id" >&2
    printf '  tmux session : %s%s\n' "$sess" \
      "$(tmux has-session -t "=$sess" 2>/dev/null && printf ' (already running)')" >&2
    printf '  directory    : %s\n' "$cwd" >&2
    printf '  claude session: %s\n' "$uuid" >&2
    if [ "$mode" = fresh ] && [ -n "$handoff" ]; then
      printf '  primed from the last handoff block on the bead\n' >&2
    fi
    printf 'bdw: nothing was claimed, labelled or launched\n' >&2
    return
  fi

  bd update "$id" --claim >/dev/null ||
    die "could not claim $id"
  bd update "$id" \
    --add-label bdw \
    --set-metadata "bdw_session=$uuid" \
    --set-metadata "bdw_tmux=$sess" \
    --set-metadata "bdw_cwd=$cwd" \
    --set-metadata "bdw_host=$(uname -n)" >/dev/null ||
    die "could not record session metadata on $id"

  mkdir -p "$state_dir/by-session"
  printf '%s' "$id" >"$state_dir/by-session/$uuid"

  # Launch through a state file rather than an argv the tmux command string
  # would have to re-quote: the prime prompt is multi-line prose.
  local launch=$state_dir/$sess.launch
  {
    printf 'bdw_id=%q\n' "$id"
    printf 'bdw_uuid=%q\n' "$uuid"
    printf 'bdw_mode=%q\n' "$mode"
    printf 'bdw_name=%q\n' "$id: $(jq -r .title <<<"$bead")"
  } >"$launch"
  if [ "$mode" = fresh ]; then
    prime_prompt "$bead" "$handoff" >"$state_dir/$sess.prompt"
  fi

  tmux new-session -d -s "$sess" -c "$cwd" "$self" _exec "$sess" ||
    die "tmux could not create session $sess"
  printf 'bdw: %s -> tmux %s (%s, session %s)\n' "$id" "$sess" "$mode" "$uuid" >&2
  attach_to "$sess"
}

# Runs inside the tmux session. Exists so the prompt never has to survive a
# round trip through tmux's command-string quoting.
cmd_exec() {
  local sess=${1:?} launch=$state_dir/${1:?}.launch
  local bdw_id bdw_uuid bdw_mode bdw_name
  # shellcheck source=/dev/null
  . "$launch"
  export BDW_BEAD=$bdw_id
  if [ "$bdw_mode" = resume ]; then
    exec claude --resume "$bdw_uuid" -n "$bdw_name"
  fi
  exec claude --session-id "$bdw_uuid" -n "$bdw_name" \
    "$(cat "$state_dir/$sess.prompt")"
}

attach_to() {
  local sess=$1
  tmux has-session -t "=$sess" 2>/dev/null ||
    die "no tmux session $sess"
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "=$sess"
  else
    tmux attach-session -t "=$sess"
  fi
}

cmd_attach() {
  local id=${1:-}
  [ -n "$id" ] || usage
  local bead sess
  bead=$(bead_json "$id") || die "no bead matching '$id'"
  sess=$(meta "$bead" bdw_tmux)
  [ -n "$sess" ] || sess=$(tmux_name "$(jq -r .id <<<"$bead")")
  tmux has-session -t "=$sess" 2>/dev/null ||
    die "no tmux session $sess -- run: bdw start $id"
  attach_to "$sess"
}

cmd_ls() {
  local ids agents sessions beads
  ids=$(bd query 'label=bdw' --json 2>/dev/null | jq -r '.[].id' || true)
  if [ -z "$ids" ]; then
    printf '[]\n'
    return
  fi
  # shellcheck disable=SC2086  # ids is a deliberate word list of bead IDs
  beads=$(bd show $ids --json 2>/dev/null || printf '[]')
  agents=$(claude agents --json 2>/dev/null || printf '[]')
  sessions=$({ tmux list-sessions -F '#{session_name}' 2>/dev/null || true; } |
    jq -Rs 'split("\n") | map(select(length > 0))')

  jq -n \
    --argjson beads "$beads" \
    --argjson agents "$agents" \
    --argjson tmux "$sessions" \
    '[$beads[] | . as $b | {
        id, title, status,
        session: (.metadata.bdw_session // null),
        tmux:    (.metadata.bdw_tmux // null),
        cwd:     (.metadata.bdw_cwd // null),
        host:    (.metadata.bdw_host // null),
        live:    ((.metadata.bdw_tmux // "") as $t | $tmux | index($t) != null),
        claude:  ([$agents[] | select(.sessionId == ($b.metadata.bdw_session // ""))]
                   | first | .status // null)
      }]' |
    if [ "${1:-}" = --human ]; then jq .; else jq -c .; fi
}

# Reads the ended session's own transcript back and writes the conclusion onto
# the bead. --tools "" keeps it a pure summarisation pass, and --fork-session
# keeps it out of the work transcript it is reading.
harvest_prompt='Summarise this session for the issue tracker. Reply with JSON only,
no prose and no code fence, matching exactly:
{"summary": "...", "handoff": "...", "done": true|false}
summary: what was accomplished and what was decided, in a few sentences.
handoff: what the next session must know to pick this up cold -- current state,
the next concrete step, and any trap you hit. Empty string if the work is done.
done: true only if the task is genuinely complete and needs no follow-up.'

cmd_harvest() {
  local id=${1:?} close=${2:-}
  local bead uuid raw inner summary handoff complete stamp

  bead=$(bead_json "$id") || die "no bead matching '$id'"
  id=$(jq -r .id <<<"$bead")
  uuid=$(meta "$bead" bdw_session)
  [ -n "$uuid" ] || die "$id has no bdw session to harvest"

  # The hook fires *at* SessionEnd, while the session it wants to read is still
  # shutting down; the first attempt can come back with a plain-text complaint
  # instead of the wrapper JSON. Retry rather than lose the harvest.
  local attempt out
  for attempt in 1 2 3; do
    out=$(BDW_HARVEST=1 claude -p --resume "$uuid" --fork-session --tools "" \
      --output-format json "$harvest_prompt" 2>/dev/null || true)
    raw=$(jq -r '.result // empty' <<<"$out" 2>/dev/null || true)
    [ -z "$raw" ] || break
    [ "$attempt" -eq 3 ] || sleep "$((attempt * ${BDW_RETRY_DELAY:-5}))"
  done

  if [ -z "$raw" ]; then
    # A silent failure would look exactly like a session with nothing to say,
    # so say so on the bead rather than dropping it.
    printf '## bdw session %s (%s)\nHarvest failed: no usable reply from claude --resume.\n' \
      "$uuid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | bd note "$id" --stdin >/dev/null || true
    die "harvest produced nothing for $id after 3 attempts (transcript gone?)"
  fi

  # The model was asked for bare JSON; if it disobeyed, keep the prose rather
  # than losing the harvest entirely.
  if inner=$(jq -e . <<<"$raw" 2>/dev/null); then
    summary=$(jq -r '.summary // ""' <<<"$inner")
    handoff=$(jq -r '.handoff // ""' <<<"$inner")
    complete=$(jq -r '.done // false' <<<"$inner")
  else
    summary=$raw
    handoff=''
    complete=false
  fi

  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  {
    printf '## bdw session %s (%s)\n%s\n' "$uuid" "$stamp" "$summary"
    if [ -n "$handoff" ]; then
      printf '\n%s\n%s\n' "$handoff_marker" "$handoff"
    fi
  } | bd note "$id" --stdin >/dev/null || die "could not write note onto $id"

  bd update "$id" --set-metadata "bdw_harvested=$stamp" >/dev/null || true

  if [ "$close" = --close ]; then
    bd close "$id" --session "$uuid" \
      --reason "$(head -c 200 <<<"$summary")" >/dev/null ||
      die "could not close $id"
    printf 'bdw: harvested and closed %s\n' "$id" >&2
  else
    printf 'bdw: harvested %s (done=%s)\n' "$id" "$complete" >&2
  fi
}

cmd_finish() {
  local id=${1:-} close=${2:-}
  [ -n "$id" ] || usage
  cmd_harvest "$id" "$close"
}

# SessionEnd hook. Must return well inside the hook budget, so it resolves the
# bead from the reverse index and detaches the real work.
cmd_hook() {
  [ -z "${BDW_HARVEST:-}" ] || exit 0 # never harvest the harvester

  local payload uuid id
  payload=$(cat)
  uuid=$(jq -r '.session_id // ""' <<<"$payload" 2>/dev/null) || exit 0
  [ -n "$uuid" ] || exit 0

  id=$(cat "$state_dir/by-session/$uuid" 2>/dev/null) || exit 0
  [ -n "$id" ] || exit 0

  setsid -f "$self" harvest "$id" >/dev/null 2>&1 </dev/null || true
  exit 0
}

case "${1:-}" in
  start) shift && cmd_start "$@" ;;
  attach) shift && cmd_attach "$@" ;;
  ls) shift && cmd_ls "$@" ;;
  finish) shift && cmd_finish "$@" ;;
  harvest) shift && cmd_harvest "$@" ;;
  hook) cmd_hook ;;
  _exec) shift && cmd_exec "$@" ;;
  *) usage ;;
esac
