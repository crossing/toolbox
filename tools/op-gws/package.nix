{ lib
, writeShellApplication
, coreutils
, jq
, curl
, gws
, safe-op
, accounts ? { }
, accountNotes ? { }
, defaultAccount ? null
, vault ? null
}:

# As with safe-op, `op` is intentionally absent from runtimeInputs: op-gws calls bare
# `op item edit`, which must resolve to the ambient 1Password wrapper rather than a
# nix-pinned copy. safe-op IS pinned, because the guard should be the one we ship.
#
# `accounts` maps account names to 1Password item references, e.g.
# { work = "gws-work"; personal = "gws-personal"; }. Together with `defaultAccount`
# and `vault` it is baked into the script as environment-variable defaults, so a
# consumer (home-ops) configures concrete items with `op-gws.override { ... }` while
# the environment can still override everything at runtime.
let
  itemsSpec = lib.concatStringsSep ","
    (lib.mapAttrsToList (name: item: "${name}=${item}") accounts);
  # Free-text notes surfaced by `op-gws --accounts`; same pair encoding as the item
  # map, so notes must not contain `,` or `=`.
  notesSpec = lib.concatStringsSep ","
    (lib.mapAttrsToList (name: note: "${name}=${note}") accountNotes);

  bakedConfig = ''
    # Build-time configuration; the environment always wins.
    : "''${OP_GWS_ITEMS:=${itemsSpec}}"
    : "''${OP_GWS_ACCOUNT_NOTES:=${notesSpec}}"
    ${lib.optionalString (defaultAccount != null) '': "''${OP_GWS_DEFAULT_ACCOUNT:=${defaultAccount}}"''}
    ${lib.optionalString (vault != null) '': "''${OP_GWS_VAULT:=${vault}}"''}
  '';
in
writeShellApplication {
  name = "op-gws";
  runtimeInputs = [ coreutils jq curl gws safe-op ];
  text = bakedConfig + builtins.readFile ./op-gws.sh;

  meta = {
    description = "Run gws with a Google access token minted from 1Password credentials";
    longDescription = ''
      Resolves a 1Password item per Google account, exchanges the stored refresh token
      for an access token (cached back into the item until expiry), and execs gws with
      GOOGLE_WORKSPACE_CLI_TOKEN set. Supports multiple accounts; tokens never touch
      disk.
    '';
    mainProgram = "op-gws";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
