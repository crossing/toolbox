{ lib, pkgs, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "ibgateway";
  src = ../../tools/ibgateway;
  tests = [
    ../../tools/ibgateway/tests/test-runtime-pinning.sh
    ../../tools/ibgateway/tests/test-network-isolation.sh
  ];
  meta.platforms = lib.platforms.linux;
}
