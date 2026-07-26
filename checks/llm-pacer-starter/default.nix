{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "llm-pacer-starter";
  src = ../../tools/llm-pacer;
  tests = [
    ../../tools/llm-pacer/tests/test-starter.sh
    ../../tools/llm-pacer/tests/test-opencode-launcher.sh
  ];
  extraInputs = [
    inputs.self.packages.${stdenv.hostPlatform.system}.llm-pacer
    pkgs.gnused
    pkgs.util-linux
  ];
  meta.platforms = pkgs.lib.platforms.linux;
}
