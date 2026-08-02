{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "op-freeagent";
  src = ../../tools/op-freeagent;
  tests = [ ../../tools/op-freeagent/tests/test-op-freeagent.sh ];
  extraInputs = [ inputs.self.packages.${stdenv.hostPlatform.system}.op-freeagent ];
}
