{
  description = "crossing/toolbox -- agent-facing command-line tools";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    snowfall-lib = {
      url = "github:snowfallorg/lib";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Required only by tools/ibkr-cli, which builds a third-party Python CLI from a
    # vendored uv.lock. Migrated verbatim from home-ops, which no longer needs them.
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
    };
  };

  outputs = inputs:
    let
      inherit (inputs.nixpkgs) lib;

      allSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      snowfallOutputs = inputs.snowfall-lib.mkFlake {
        inherit inputs;
        src = ./.;

        supportedSystems = allSystems;

        snowfall = {
          # Avoid colliding with nixpkgs' existing `toolbox` package. This namespace
          # is only used while Snowfall resolves sibling packages.
          namespace = "toolbox-internal";
          meta = {
            name = "toolbox";
            title = "Toolbox";
          };
        };

        alias.packages.default = "safe-op";

        outputs-builder = channels: {
          formatter = channels.nixpkgs.nixpkgs-fmt;
        };
      };
    in
    {
      # Keep the public flake contract unchanged while Snowfall handles discovery and
      # the internal package namespace. The generated package outputs are flat, as
      # before; only sibling package resolution uses pkgs.toolbox-internal internally.
      inherit (snowfallOutputs) packages checks devShells formatter;

      overlays.default = _final: prev:
        let
          packages = snowfallOutputs.packages.${prev.stdenv.hostPlatform.system};
        in
        {
          inherit (packages) safe-op op-oauth2c op-gws op-gws-onboard patch-gws-skills freeagent op-freeagent toolbox-skills;
        }
        // lib.optionalAttrs prev.stdenv.hostPlatform.isLinux {
          inherit (packages) ibkr-cli ibgateway ibkr-local ibkr-x11 whatsapp-bridge whatsapp-mcp-server;
        };
    };
}
