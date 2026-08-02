{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "op-gws-onboard";
  src = ../../tools/op-gws-onboard;
  tests = [ ../../tools/op-gws-onboard/tests/test-op-gws-onboard.sh ];
  extraInputs = [ pkgs.jq inputs.self.packages.${stdenv.hostPlatform.system}.op-gws-onboard ];
}
