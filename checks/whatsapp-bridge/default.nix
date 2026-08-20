{ lib, inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "whatsapp-bridge";
  src = ../../tools/whatsapp-bridge;
  tests = [ ../../tools/whatsapp-bridge/tests/test-whatsapp-bridge.sh ];
  extraInputs = [
    inputs.self.packages.${stdenv.hostPlatform.system}.whatsapp-bridge
  ];
  meta.platforms = lib.platforms.linux;
}
