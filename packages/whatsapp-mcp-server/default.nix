{ callPackage, inputs, ... }:

callPackage ../../tools/whatsapp-mcp-server/package.nix {
  inherit (inputs) pyproject-nix uv2nix pyproject-build-systems;
}
