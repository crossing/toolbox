{ callPackage, pkgs, namespace, ... }:

# item is passed explicitly so callPackage cannot satisfy it from a same-named
# nixpkgs attribute. Consumers configure it via `op-freeagent.override { item = ...; }`.
callPackage ../../tools/op-freeagent/package.nix {
  inherit (pkgs.${namespace}) freeagent op-oauth2c safe-op;
  item = null;
}
