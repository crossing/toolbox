{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "op-gws";
  src = ../../tools/op-gws;
  tests = [ ../../tools/op-gws/tests/test-op-gws.sh ];
  extraInputs = [ pkgs.jq inputs.self.packages.${stdenv.hostPlatform.system}.op-gws ];
}
