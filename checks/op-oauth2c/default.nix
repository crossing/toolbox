{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "op-oauth2c";
  src = ../../tools/op-oauth2c;
  tests = [ ../../tools/op-oauth2c/tests/test-op-oauth2c.sh ];
  extraInputs = [ pkgs.jq inputs.self.packages.${stdenv.hostPlatform.system}.op-oauth2c ];
}
