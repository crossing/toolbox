{ lib, writeShellApplication, coreutils, jq, gws }:

# As with safe-op, `op` is intentionally absent from runtimeInputs: op-gws-onboard
# calls bare `op item edit`, which must resolve to the ambient 1Password wrapper
# rather than a nix-pinned copy.
writeShellApplication {
  name = "op-gws-onboard";
  runtimeInputs = [ coreutils jq gws ];
  text = builtins.readFile ./op-gws-onboard.sh;

  meta = {
    description = "Onboard a Google account for op-gws: browser login, credentials harvested into 1Password";
    longDescription = ''
      Runs gws auth login in a throwaway config dir, exports the resulting OAuth
      credentials unmasked, and writes them into a 1Password item as the
      gws_-prefixed fields op-gws consumes. No secret is ever displayed.
    '';
    mainProgram = "op-gws-onboard";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
