{
  description = "Safe CLI integrations for AI agents";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages = {
          safe-op = pkgs.writeShellApplication {
            name = "safe-op";
            runtimeInputs = [ pkgs.coreutils ];
            text = builtins.readFile ./src/safe-op.sh;
          };

          op-oauth2c = pkgs.writeShellApplication {
            name = "op-oauth2c";
            runtimeInputs = [ 
              pkgs.coreutils 
              pkgs.jq 
              pkgs.oauth2c
            ];
            text = builtins.readFile ./src/op-oauth2c.sh;
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.jq
            pkgs.oauth2c
          ];
          shellHook = ''
            export PATH="$PWD/bin:$PATH"
          '';
        };
      }
    );
}
