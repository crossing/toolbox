{ lib, writeShellApplication, symlinkJoin, coreutils, gawk, gnused, jq, util-linux }:

# Note: `bd`, `claude` and `tmux` are deliberately NOT in runtimeInputs.
#
# `bd` owns a mutable database under ~/.beads; pinning a different build than the
# one the user's shell runs would eventually open that database with the wrong
# schema. `claude` is installed from a flake input in the consumer (home-ops
# takes it from llm-agents, not nixpkgs), so a pinned copy here would be the
# wrong binary and a second multi-hundred-megabyte closure. `tmux` speaks a
# versioned client/server protocol -- a pinned client cannot talk to the server
# the user's own tmux already started.
#
# All three are resolved from the ambient PATH on purpose. bdw fails with a
# plain "command not found" if they are absent, which is the correct diagnosis.
let
  bdw = writeShellApplication {
    name = "bdw";
    runtimeInputs = [
      coreutils
      gawk
      gnused
      jq
      util-linux # setsid, for detaching the harvest from the hook
    ];
    text = builtins.readFile ./bdw.sh;
  };
in
# writeShellApplication produces bin/ and nothing else, so the completions are
# joined on afterwards. Both land where a shell already looks: home-manager puts
# the profile's share/zsh/site-functions on fpath (that is how `beads` ships its
# own `_bd`), and bash-completion reads share/bash-completion/completions.
symlinkJoin {
  name = "bdw";
  paths = [ bdw ];
  postBuild = ''
    install -Dm644 ${./completions/_bdw} "$out/share/zsh/site-functions/_bdw"
    install -Dm644 ${./completions/bdw.bash} "$out/share/bash-completion/completions/bdw"
  '';

  meta = {
    description = "One Claude Code session per bead, harvested back onto the bead";
    longDescription = ''
      Opens a tmux session per beads issue, priming Claude Code with the bead's
      description, design and notes, and records the Claude session ID on the
      bead so the work can be resumed later. When a session ends, a SessionEnd
      hook harvests its conclusions into the bead's notes along with a handoff
      block, so a bead whose transcript is gone can still be picked up cold.
    '';
    mainProgram = "bdw";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux; # /proc/sys/kernel/random/uuid
  };
}
