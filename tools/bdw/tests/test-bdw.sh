#!/usr/bin/env bash
# Exercises bdw against mock bd/claude/tmux binaries. Nothing here touches a
# real beads database, a real transcript, or a real tmux server.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tool_dir=${TOOL_SRC:-$script_dir/..}
bdw="$tool_dir/bdw.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fails=0
ok() { printf '  ok   %s\n' "$1"; }
no() {
  printf '  FAIL %s\n' "$1"
  fails=$((fails + 1))
}
check() {
  # check <label> <needle> <file>
  if grep -qF -- "$2" "$3"; then ok "$1"; else
    no "$1 (missing: $2)"
    sed 's/^/       | /' "$3" >&2
  fi
}
refute() {
  if grep -qF -- "$2" "$3"; then no "$1 (unexpected: $2)"; else ok "$1"; fi
}

# --- mocks -----------------------------------------------------------------

mkdir -p "$tmp/bin"
bash_path=$(command -v bash)

cat >"$tmp/bin/bd" <<EOF
#!$bash_path
printf '%s\n' "\$*" >>"$tmp/bd.log"
case "\$1" in
  show)  cat "\$BDW_TEST_BEAD" ;;
  query) if [ -s "$tmp/query.json" ]; then cat "$tmp/query.json"; else printf '[]\n'; fi ;;
  note)  cat >>"$tmp/note.txt" ;;
esac
exit 0
EOF

cat >"$tmp/bin/claude" <<EOF
#!$bash_path
printf '%s\n' "\$*" >>"$tmp/claude.log"
if [ "\$1" = agents ]; then printf '[]\n'; exit 0; fi
if [ -s "$tmp/claude.flaky" ]; then
  if [ "\$(cat "$tmp/claude.flaky")" = always ]; then
    printf 'Error: Session ID is already in use.\n'; exit 1
  fi
  rm -f "$tmp/claude.flaky"
  printf 'Error: Session ID is already in use.\n'; exit 1
fi
printf '%s\n' '{"result":"{\\"summary\\":\\"did the thing\\",\\"handoff\\":\\"next: wire the check\\",\\"done\\":false}"}'
EOF

# Stateful enough to be honest: new-session registers a session, has-session
# only succeeds for one that exists. A mock that always answered "no session"
# would have hidden the fact that start attaches to what it just created.
cat >"$tmp/bin/tmux" <<EOF
#!$bash_path
printf '%s\n' "\$*" >>"$tmp/tmux.log"
mkdir -p "$tmp/sessions"
name=\${3#=}
case "\$1" in
  new-session)   touch "$tmp/sessions/\$4" ;;
  has-session)   [ -e "$tmp/sessions/\$name" ] || exit 1 ;;
  list-sessions) ls "$tmp/sessions" 2>/dev/null || exit 1 ;;
esac
exit 0
EOF

chmod +x "$tmp/bin/bd" "$tmp/bin/claude" "$tmp/bin/tmux"
export PATH="$tmp/bin:$PATH"
export BDW_STATE_DIR="$tmp/state"
export BDW_RETRY_DELAY=0  # keep the retry test instant

bead() {
  # bead <id> [extra-metadata-json]
  local meta=${2:-}
  [ -n "$meta" ] || meta='{}'
  jq -n --arg id "$1" --argjson meta "$meta" \
    '[{id: $id, title: "Wire the thing", status: "open",
       description: "A description.", notes: "prior note\n## bdw handoff\ncarry this forward",
       metadata: $meta}]' >"$tmp/bead.json"
  export BDW_TEST_BEAD="$tmp/bead.json"
}

reset() {
  : >"$tmp/bd.log"; : >"$tmp/claude.log"; : >"$tmp/tmux.log"; : >"$tmp/note.txt"
  : >"$tmp/query.json"
  rm -f "$tmp/claude.flaky"
  rm -rf "$tmp/sessions"
}

# --- usage -----------------------------------------------------------------

printf 'usage\n'
rc=0
bash "$bdw" >"$tmp/out" 2>"$tmp/err" || rc=$?
[ "$rc" -eq 2 ] && ok "no args exits 2" || no "no args exits 2 (got $rc)"
check "usage names start" "bdw start" "$tmp/err"

# --- fresh start -----------------------------------------------------------

printf 'start (fresh bead)\n'
reset
bead work-abc
bash "$bdw" start work-abc >/dev/null 2>"$tmp/err"
check "claims the bead" "update work-abc --claim" "$tmp/bd.log"
check "labels it bdw" "--add-label bdw" "$tmp/bd.log"
check "records session id" "--set-metadata bdw_session=" "$tmp/bd.log"
check "records tmux name" "--set-metadata bdw_tmux=bd-work-abc" "$tmp/bd.log"
check "creates the session" "new-session -d -s bd-work-abc" "$tmp/tmux.log"
check "attaches after creating" "attach-session -t =bd-work-abc" "$tmp/tmux.log"

uuid=$(sed -n 's/.*--set-metadata bdw_session=\([^ ]*\).*/\1/p' "$tmp/bd.log" | head -1)
[ -n "$uuid" ] && ok "minted a session id" || no "minted a session id"
[ -f "$BDW_STATE_DIR/by-session/$uuid" ] &&
  ok "reverse index written" || no "reverse index written"
check "index points at the bead" "work-abc" "$BDW_STATE_DIR/by-session/$uuid"
check "launch file says fresh" "bdw_mode=fresh" "$BDW_STATE_DIR/bd-work-abc.launch"
check "prompt carries the title" "Wire the thing" "$BDW_STATE_DIR/bd-work-abc.prompt"
check "prompt carries description" "A description." "$BDW_STATE_DIR/bd-work-abc.prompt"

# --- dry run ----------------------------------------------------------------

printf 'start --dry-run\n'
reset
bead work-abc
bash "$bdw" start work-abc --dry-run >/dev/null 2>"$tmp/err"
check "says what it would do" "would fresh work-abc" "$tmp/err"
check "names the tmux session" "bd-work-abc" "$tmp/err"
check "says it changed nothing" "nothing was claimed" "$tmp/err"
refute "does not claim the bead" "--claim" "$tmp/bd.log"
refute "does not label the bead" "--add-label" "$tmp/bd.log"
refute "does not create a session" "new-session" "$tmp/tmux.log"

reset
bead work-abc
bash "$bdw" start --dry-run work-abc >/dev/null 2>"$tmp/err"
check "accepts the flag before the id" "would fresh work-abc" "$tmp/err"

# --- restarting something already open -------------------------------------

printf 'start (session already running)\n'
reset
bead work-abc
bash "$bdw" start work-abc >/dev/null 2>&1
: >"$tmp/tmux.log"
: >"$tmp/bd.log"
bash "$bdw" start work-abc >/dev/null 2>&1
refute "does not recreate the session" "new-session" "$tmp/tmux.log"
check "attaches to the running one" "attach-session -t =bd-work-abc" "$tmp/tmux.log"
refute "does not re-claim a running bead" "--claim" "$tmp/bd.log"

# --- tmux name sanitising --------------------------------------------------

printf 'start (subtask id with a dot)\n'
reset
bead work-ysf.6
bash "$bdw" start work-ysf.6 >/dev/null 2>&1
check "dot becomes dash" "new-session -d -s bd-work-ysf-6" "$tmp/tmux.log"

# --- resume on the same host -----------------------------------------------

printf 'start (existing session, same host)\n'
reset
bead work-abc "$(jq -n --arg h "$(uname -n)" \
  '{bdw_session: "11111111-1111-1111-1111-111111111111", bdw_tmux: "bd-work-abc", bdw_host: $h}')"
bash "$bdw" start work-abc >/dev/null 2>&1
check "launch file says resume" "bdw_mode=resume" "$BDW_STATE_DIR/bd-work-abc.launch"
check "keeps the old session id" "bdw_session=11111111-1111-1111-1111-111111111111" "$tmp/bd.log"

# --- handoff fallback on another host --------------------------------------

printf 'start (session belongs to another host)\n'
reset
rm -f "$BDW_STATE_DIR/bd-work-abc.prompt"
bead work-abc '{"bdw_session": "11111111-1111-1111-1111-111111111111", "bdw_tmux": "bd-work-abc", "bdw_host": "elsewhere"}'
bash "$bdw" start work-abc >/dev/null 2>&1
check "falls back to fresh" "bdw_mode=fresh" "$BDW_STATE_DIR/bd-work-abc.launch"
check "primes from the handoff" "carry this forward" "$BDW_STATE_DIR/bd-work-abc.prompt"
refute "does not reuse the dead id" "bdw_session=11111111" "$tmp/bd.log"

# --- harvest ---------------------------------------------------------------

printf 'harvest\n'
reset
bead work-abc '{"bdw_session": "22222222-2222-2222-2222-222222222222"}'
bash "$bdw" harvest work-abc >/dev/null 2>&1
check "resumes the right transcript" "--resume 22222222-2222-2222-2222-222222222222" "$tmp/claude.log"
check "forks rather than appending" "--fork-session" "$tmp/claude.log"
check "summary lands in the notes" "did the thing" "$tmp/note.txt"
check "handoff is marked" "## bdw handoff" "$tmp/note.txt"
check "handoff body lands too" "next: wire the check" "$tmp/note.txt"
check "stamps the harvest" "--set-metadata bdw_harvested=" "$tmp/bd.log"
refute "does not close on its own" "close work-abc" "$tmp/bd.log"

printf 'finish --close\n'
reset
bash "$bdw" finish work-abc --close >/dev/null 2>&1
check "closes the bead" "close work-abc" "$tmp/bd.log"
check "records the session on close" "--session 22222222-2222-2222-2222-222222222222" "$tmp/bd.log"

# --- harvest resilience ----------------------------------------------------

printf 'harvest (first attempt returns junk)\n'
reset
bead work-abc '{"bdw_session": "22222222-2222-2222-2222-222222222222"}'
# Make the mock answer the first call with the plain-text complaint Claude Code
# emits when the session it is asked to resume is still shutting down.
printf '1' >"$tmp/claude.flaky"
bash "$bdw" harvest work-abc >/dev/null 2>&1
check "retries past the junk reply" "did the thing" "$tmp/note.txt"
rm -f "$tmp/claude.flaky"

printf 'harvest (never recovers)\n'
reset
printf 'always' >"$tmp/claude.flaky"
rc=0
bash "$bdw" harvest work-abc >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] && ok "gives up with exit 1" || no "gives up with exit 1 (got $rc)"
check "records the failure on the bead" "Harvest failed" "$tmp/note.txt"
rm -f "$tmp/claude.flaky"

# --- ls --------------------------------------------------------------------

printf 'ls\n'
reset
bead work-abc '{"bdw_session": "33333333-3333-3333-3333-333333333333", "bdw_tmux": "bd-work-abc", "bdw_cwd": "/w", "bdw_host": "here"}'
printf '[{"id": "work-abc"}]' >"$tmp/query.json"
mkdir -p "$tmp/sessions" && touch "$tmp/sessions/bd-work-abc"
bash "$bdw" ls --human >"$tmp/ls.json" 2>"$tmp/err"
check "ls reports the bead" '"id": "work-abc"' "$tmp/ls.json"
check "ls reports the session id" '33333333-3333-3333-3333-333333333333' "$tmp/ls.json"
check "ls sees the live tmux session" '"live": true' "$tmp/ls.json"
rm -f "$tmp/sessions/bd-work-abc"
bash "$bdw" ls --human >"$tmp/ls.json" 2>&1
check "ls sees a dead session as dead" '"live": false' "$tmp/ls.json"

reset
bash "$bdw" ls >"$tmp/ls.json" 2>&1
check "ls with no bdw beads is an empty array" '[]' "$tmp/ls.json"

# --- completion -------------------------------------------------------------
# The bash completion is sourced and driven for real; the zsh one is only parsed,
# since driving zsh's completion system needs an interactive shell.
#
# nixpkgs' plain `bash` is built without programmable completion, so the driver
# has to go looking for one that has `complete` -- bashInteractive, which the
# check puts on PATH.

find_comp_bash() {
  local dir candidate
  local -a dirs
  IFS=: read -r -a dirs <<<"$PATH"
  for dir in "${dirs[@]}"; do
    candidate=$dir/bash
    [ -x "$candidate" ] || continue
    if "$candidate" -c 'type complete' >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

printf 'completion (bash)\n'
reset
printf '[{"id": "work-abc", "title": "Wire the thing"}, {"id": "work-ysf.6", "title": "A subtask"}]' \
  >"$tmp/query.json"

if comp_bash=$(find_comp_bash); then
  complete_at() {
    # complete_at <word>... -- the last word is the one being completed
    "$comp_bash" -c '
      . "$1"; shift
      COMP_WORDS=("$@"); COMP_CWORD=$(($# - 1)); COMPREPLY=()
      _bdw
      printf "%s\n" "${COMPREPLY[@]}"
    ' _ "$tool_dir/completions/bdw.bash" "$@"
  }

  complete_at bdw '' >"$tmp/comp.txt"
  check "completes subcommands" "attach" "$tmp/comp.txt"
  check "completes finish" "finish" "$tmp/comp.txt"

  complete_at bdw start '' >"$tmp/comp.txt"
  check "start offers bead ids" "work-abc" "$tmp/comp.txt"
  check "start offers dotted subtask ids" "work-ysf.6" "$tmp/comp.txt"
  check "start queries open work" "query status!=closed" "$tmp/bd.log"

  complete_at bdw attach '' >"$tmp/comp.txt"
  check "attach queries only bdw beads" "query label=bdw" "$tmp/bd.log"

  complete_at bdw start work-y >"$tmp/comp.txt"
  check "start filters on the prefix" "work-ysf.6" "$tmp/comp.txt"
  refute "prefix filter excludes the rest" "work-abc" "$tmp/comp.txt"

  complete_at bdw finish work-abc '' >"$tmp/comp.txt"
  check "finish offers --close after the id" "--close" "$tmp/comp.txt"

  complete_at bdw ls '' >"$tmp/comp.txt"
  check "ls offers --human" "--human" "$tmp/comp.txt"
else
  no "no bash with programmable completion on PATH"
fi

printf 'completion (zsh)\n'
if command -v zsh >/dev/null 2>&1; then
  if zsh -n "$tool_dir/completions/_bdw" 2>"$tmp/err"; then
    ok "zsh completion parses"
  else
    no "zsh completion parses"
    sed 's/^/       | /' "$tmp/err" >&2
  fi
else
  no "zsh not on PATH to parse the completion"
fi
head -1 "$tool_dir/completions/_bdw" >"$tmp/comp.txt"
check "zsh completion declares its compdef" "#compdef bdw" "$tmp/comp.txt"

# --- hook ------------------------------------------------------------------

printf 'hook\n'
reset
rc=0
printf '{"session_id":"unknown-uuid","hook_event_name":"SessionEnd"}' |
  bash "$bdw" hook || rc=$?
[ "$rc" -eq 0 ] && ok "unknown session exits 0" || no "unknown session exits 0 (got $rc)"
refute "unknown session harvests nothing" "note" "$tmp/bd.log"

reset
rc=0
printf '{"session_id":"22222222-2222-2222-2222-222222222222"}' |
  BDW_HARVEST=1 bash "$bdw" hook || rc=$?
[ "$rc" -eq 0 ] && ok "harvester's own exit is ignored" ||
  no "harvester's own exit is ignored (got $rc)"
refute "no recursive harvest" "resume" "$tmp/claude.log"

# ---------------------------------------------------------------------------

if [ "$fails" -ne 0 ]; then
  printf '\n%d check(s) failed\n' "$fails" >&2
  exit 1
fi
printf '\nall bdw checks passed\n'
