{ callPackage, pkgs, namespace, ... }:

# item is passed explicitly so callPackage cannot satisfy it from a same-named
# nixpkgs attribute. See packages/op-gws/default.nix for why configuration goes
# through `withConfig` rather than `.override`: Snowfall's makeOverridable shadows
# the inner override with one whose `...` silently drops unknown arguments.
let
  pkg = callPackage ../../tools/op-freeagent/package.nix {
    inherit (pkgs.${namespace}) freeagent op-oauth2c safe-op;
    item = null;
  };
in
pkg // { withConfig = pkg.override; }
