{ pkgs, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "bdw";
  src = ../../tools/bdw;
  tests = [ ../../tools/bdw/tests/test-bdw.sh ];
  # bashInteractive and zsh are here for the completion tests: nixpkgs' plain
  # `bash` is built without programmable completion, so the bash completion
  # cannot be driven by it, and the zsh completion is parsed with `zsh -n`.
  extraInputs = with pkgs; [
    bashInteractive
    gawk
    gnused
    jq
    util-linux
    zsh
  ];
  meta.platforms = pkgs.lib.platforms.linux;
}
