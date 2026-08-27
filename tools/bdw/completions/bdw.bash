# bash completion for bdw. See completions/_bdw for the zsh version, which also
# offers each bead's title as a description; bash gets the IDs alone.

_bdw_bead_ids() {
  bd query "$1" --json 2>/dev/null | jq -r '.[].id' 2>/dev/null
}

_bdw() {
  local cur cmd
  cur=${COMP_WORDS[COMP_CWORD]}
  cmd=${COMP_WORDS[1]}

  # The first word can be a subcommand or, for the `bdw <bead-id>` shortcut, a
  # bead ID; both are offered.
  if [ "$COMP_CWORD" -eq 1 ]; then
    mapfile -t COMPREPLY < <(compgen \
      -W "start attach ls finish hook $(_bdw_bead_ids 'status!=closed')" -- "$cur")
    return
  fi

  case $cmd in
    start)
      if [ "$COMP_CWORD" -eq 2 ]; then
        mapfile -t COMPREPLY < <(compgen -W "$(_bdw_bead_ids 'status!=closed')" -- "$cur")
      else
        mapfile -t COMPREPLY < <(compgen -W "--dry-run" -- "$cur")
      fi
      ;;
    attach)
      mapfile -t COMPREPLY < <(compgen -W "$(_bdw_bead_ids 'label=bdw')" -- "$cur")
      ;;
    finish)
      if [ "$COMP_CWORD" -eq 2 ]; then
        mapfile -t COMPREPLY < <(compgen -W "$(_bdw_bead_ids 'label=bdw')" -- "$cur")
      else
        mapfile -t COMPREPLY < <(compgen -W "--close" -- "$cur")
      fi
      ;;
    ls)
      mapfile -t COMPREPLY < <(compgen -W "--human" -- "$cur")
      ;;
    hook) ;;
    *) # a bead ID in the first word: the shortcut, which takes start's flags
      mapfile -t COMPREPLY < <(compgen -W "--dry-run" -- "$cur")
      ;;
  esac
}

complete -F _bdw bdw
