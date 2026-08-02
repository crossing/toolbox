{ lib
, writeShellApplication
, coreutils
, gnugrep
, freeagent
, op-oauth2c
, safe-op
, item ? null
}:

# As with safe-op, `op` is intentionally absent from runtimeInputs: reads must resolve
# to the ambient 1Password wrapper. safe-op and op-oauth2c ARE pinned; they are ours.
#
# `item` bakes the 1Password item reference in as an environment-variable default, so
# a consumer (home-ops) configures it with `op-freeagent.override { item = "..."; }`
# while OP_FREEAGENT_ITEM can still override at runtime.
let
  bakedConfig = lib.optionalString (item != null) ''
    # Build-time configuration; the environment always wins.
    : "''${OP_FREEAGENT_ITEM:=${item}}"
  '';
in
writeShellApplication {
  name = "op-freeagent";
  runtimeInputs = [ coreutils gnugrep freeagent op-oauth2c safe-op ];
  text = bakedConfig + builtins.readFile ./op-freeagent.sh;

  meta = {
    description = "Run the freeagent CLI with tokens from 1Password, auto-refreshing on 401";
    longDescription = ''
      Reads the FreeAgent access token from a 1Password item, runs freeagent with it,
      and on a 401 refreshes the token via op-oauth2c --refresh and retries once.
      Tokens never touch disk.
    '';
    mainProgram = "op-freeagent";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
