{ lib, writeShellApplication, coreutils }:

# Note: `op` is deliberately NOT in runtimeInputs. writeShellApplication prepends
# runtimeInputs to PATH, so a pinned `op` would shadow the 1Password desktop app's
# setuid wrapper at /run/wrappers/bin/op -- which is the one that can actually talk to
# the local app. safe-op resolves `op` from the ambient PATH on purpose.
writeShellApplication {
  name = "safe-op";
  runtimeInputs = [ coreutils ];
  text = builtins.readFile ./safe-op.sh;

  meta = {
    description = "1Password CLI wrapper that refuses to print secrets to a TTY";
    longDescription = ''
      Wraps `op` and blocks invocations that would render a secret to a terminal,
      while allowing the same call through command substitution or a pipe. Intended
      for AI agents, which otherwise leak secrets into transcripts.
    '';
    mainProgram = "safe-op";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
