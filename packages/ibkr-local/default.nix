{ callPackage, pkgs, namespace, ... }:

callPackage ../../tools/ibkr-local/package.nix {
  inherit (pkgs.${namespace}) ibkr-cli ibgateway;
}
