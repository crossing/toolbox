{ lib, pkgs, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "ibkr-local";
  src = ../../tools/ibkr-local;
  tests = [
    ../../tools/ibkr-local/tests/test-order-entry.sh
    ../../tools/ibkr-local/tests/test-read-only-data.sh
    ../../tools/ibkr-local/tests/test-ibc-config-policy.sh
    ../../tools/ibkr-local/tests/test-flex-fetch.sh
    ../../tools/ibkr-local/tests/test-flex-routing.sh
  ];
  extraInputs = [ pkgs.jq pkgs.gawk pkgs.gnused pkgs.ripgrep pkgs.python3 ];
  meta.platforms = lib.platforms.linux;
}
