# Siblings arrive as ordinary arguments. Previously this resolved them through
# Snowfall's injected `namespace` (pkgs.${namespace}."ibkr-cli"), which only works
# inside home-ops; callPackage supplies them from the overlay here.
{ lib
, writeShellApplication
, writeTextFile
, runCommand
, symlinkJoin
, coreutils
, gawk
, gnugrep
, gnused
, jq
, python3
, ibkr-cli
, ibgateway
}:

let
  # Stdlib-only Flex Web Service client. The token arrives on stdin (never
  # argv or the environment) and errors are sanitized; see flex-fetch.py.
  flexFetch = writeTextFile {
    name = "ibkr-flex-fetch";
    destination = "/bin/ibkr-flex-fetch";
    executable = true;
    text = ''
      #!${python3}/bin/python3
      ${builtins.readFile ./flex-fetch.py}
    '';
  };

  ibkr = writeShellApplication {
    name = "ibkr";
    runtimeInputs = [
      ibgateway
      flexFetch
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
    flexFetch
  ];

  meta = {
    description = "Guarded local Interactive Brokers CLI and Gateway runtime";
    platforms = lib.platforms.linux;
  };
}
