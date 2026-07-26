{ inputs, stdenv, ... }:

let
  overlayPackages = import inputs.nixpkgs {
    system = stdenv.hostPlatform.system;
    overlays = [ inputs.self.overlays.default ];
  };
in
# Building through the public overlay runs the complete mock-only Go suite and
  # exercises the load-bearing consumer interface at the same time.
overlayPackages.llm-pacer
