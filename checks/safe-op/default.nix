{ inputs, pkgs, stdenv, ... }:

let
  inherit (import ../lib.nix { inherit pkgs; }) mkToolTest;
  overlayPkgs = import inputs.nixpkgs {
    system = stdenv.hostPlatform.system;
    overlays = [ inputs.self.overlays.default ];
  };
in
mkToolTest {
  name = "safe-op";
  src = ../../tools/safe-op;
  tests = [ ../../tools/safe-op/tests/test-safe-op.sh ];
  # Exercise the load-bearing consumer interface, not only the direct package output.
  extraInputs = [ overlayPkgs.safe-op ];
}
