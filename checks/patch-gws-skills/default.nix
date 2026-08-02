{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "patch-gws-skills";
  src = ../../tools/patch-gws-skills;
  tests = [ ../../tools/patch-gws-skills/tests/test-patch-gws-skills.sh ];
  extraInputs = [ pkgs.gawk inputs.self.packages.${stdenv.hostPlatform.system}.patch-gws-skills ];
}
