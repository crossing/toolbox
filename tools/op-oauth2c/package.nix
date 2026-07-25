{ lib, writeShellApplication, coreutils, jq, oauth2c, safe-op }:

# As with safe-op, `op` is intentionally absent from runtimeInputs: op-oauth2c calls
# bare `op item edit`, which must resolve to the ambient 1Password wrapper rather than
# a nix-pinned copy. safe-op IS pinned, because the guard should be the one we ship.
writeShellApplication {
  name = "op-oauth2c";
  runtimeInputs = [ coreutils jq oauth2c safe-op ];
  text = builtins.readFile ./op-oauth2c.sh;

  meta = {
    description = "Run an OAuth2 flow with credentials from 1Password, writing tokens back";
    longDescription = ''
      Reads client_id/client_secret from a 1Password item, runs the oauth2c flow, and
      stores the resulting access and refresh tokens back into the same item. Tokens
      never touch disk.
    '';
    mainProgram = "op-oauth2c";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
