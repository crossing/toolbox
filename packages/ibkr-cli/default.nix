{ callPackage, inputs, ... }:

callPackage ../../tools/ibkr-cli/package.nix {
  inherit (inputs) pyproject-nix uv2nix pyproject-build-systems;
}
