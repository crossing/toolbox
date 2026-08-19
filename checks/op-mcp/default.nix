{ lib, inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
in
mkToolTest {
  name = "op-mcp";
  src = ../../tools/op-mcp;
  tests = [ ../../tools/op-mcp/tests/test-op-mcp.sh ];
  # The unit tests are stdlib-only; the built package is included so the runner
  # can smoke-test the packaged entry point (with the real mcp SDK in its venv).
  extraInputs = [
    pkgs.python3
    inputs.self.packages.${stdenv.hostPlatform.system}.op-mcp
  ];
  meta.platforms = lib.platforms.linux;
}
