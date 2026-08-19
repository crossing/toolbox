{ callPackage, pkgs, namespace, inputs, ... }:

callPackage ../../tools/op-mcp/package.nix {
  inherit (inputs) pyproject-nix uv2nix pyproject-build-systems;
  inherit (pkgs.${namespace}) freeagent safe-op;
}
