# Siblings arrive as ordinary arguments. Previously this resolved them through
# Snowfall's injected `namespace` (pkgs.${namespace}."ibkr-cli"), which only works
# inside home-ops; callPackage supplies them from the overlay here.
{ lib
, writeShellApplication
, runCommand
, symlinkJoin
, coreutils
, gawk
, gnugrep
, gnused
, jq
, ibkr-cli
, ibgateway
}:

let
  ibkr = writeShellApplication {
    name = "ibkr";
    runtimeInputs = [
      ibgateway
      coreutils
      gawk
      gnugrep
      gnused
      jq
    ];
    text = ''
      export IBKR_UPSTREAM=${lib.escapeShellArg "${ibkr-cli}/bin/ibkr"}
      ${builtins.readFile ./order-entry.sh}
      ${builtins.readFile ./ibkr-local.sh}
    '';
  };

  # `ibkr-local` is the name the investment framework and its skills invoke by
  # subprocess; keep it as an alias rather than renaming the tool.
  compatibility = runCommand "ibkr-local-compat" { } ''
    mkdir -p "$out/bin"
    ln -s ${ibkr}/bin/ibkr "$out/bin/ibkr-local"
  '';
in
symlinkJoin {
  name = "ibkr-local";
  paths = [
    ibkr
    compatibility
    ibgateway
  ];

  meta = {
    description = "Guarded local Interactive Brokers CLI and Gateway runtime";
    platforms = lib.platforms.linux;
  };
}
