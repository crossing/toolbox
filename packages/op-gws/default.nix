{ callPackage, pkgs, namespace, ... }:

# accounts/defaultAccount/vault are passed explicitly so callPackage cannot satisfy
# them from nixpkgs attributes of the same name (pkgs.vault is a real package).
# Consumers configure them via `op-gws.override { accounts = ...; ... }`.
callPackage ../../tools/op-gws/package.nix {
  inherit (pkgs.${namespace}) safe-op;
  accounts = { };
  defaultAccount = null;
  vault = null;
}
