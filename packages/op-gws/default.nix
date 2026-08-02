{ callPackage, pkgs, namespace, ... }:

# accounts/accountNotes/defaultAccount/vault are passed explicitly so callPackage
# cannot satisfy them from nixpkgs attributes of the same name (pkgs.vault is a real
# package).
#
# Snowfall wraps this file in makeOverridable, which shadows the inner callPackage's
# .override with one targeting THIS file's arguments -- where `...` silently swallows
# unknown names, so `op-gws.override { accounts = ...; }` built an unconfigured
# wrapper. `withConfig` is the real configurator, under a name the wrapper cannot
# clobber; consumers use `op-gws.withConfig { accounts = ...; ... }`.
let
  pkg = callPackage ../../tools/op-gws/package.nix {
    inherit (pkgs.${namespace}) safe-op;
    accounts = { };
    accountNotes = { };
    defaultAccount = null;
    vault = null;
  };
in
pkg // { withConfig = pkg.override; }
