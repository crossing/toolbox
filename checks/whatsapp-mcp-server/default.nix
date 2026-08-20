{ lib, inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "whatsapp-mcp-server";
  src = ../../tools/whatsapp-mcp-server;
  tests = [ ../../tools/whatsapp-mcp-server/tests/test-whatsapp-mcp-server.sh ];
  # The gating test imports the server, so it runs on the package's own
  # virtualenv python (which has the mcp SDK and the project installed).
  extraInputs = [
    inputs.self.packages.${stdenv.hostPlatform.system}.whatsapp-mcp-server.passthru.env
  ];
  meta.platforms = lib.platforms.linux;
}
