{ lib, writeShellApplication, coreutils, gnused, gawk, gnugrep }:

writeShellApplication {
  name = "patch-gws-skills";
  runtimeInputs = [ coreutils gnused gawk gnugrep ];
  text = builtins.readFile ./patch-gws-skills.sh;

  meta = {
    description = "Idempotently rewrite generated gws agent skills to use op-gws";
    longDescription = ''
      Rewrites each gws-*/SKILL.md under an agent skills directory to call op-gws
      instead of bare gws and inserts an Accounts section pointing at
      `op-gws --accounts`. Safe to re-run after every `gws generate-skills`.
    '';
    mainProgram = "patch-gws-skills";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
