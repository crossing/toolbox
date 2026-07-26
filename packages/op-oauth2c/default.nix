{ callPackage, pkgs, namespace, ... }:

callPackage ../../tools/op-oauth2c/package.nix {
  inherit (pkgs.${namespace}) safe-op;
}
