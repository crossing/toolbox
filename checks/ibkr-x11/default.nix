{ lib, pkgs, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "ibkr-x11";
  src = ../../tools/ibkr-x11;
  tests = [ ../../tools/ibkr-x11/tests/test-ibkr-x11.sh ];
  extraInputs = [ pkgs.gawk pkgs.gnused ];
  meta.platforms = lib.platforms.linux;
}
