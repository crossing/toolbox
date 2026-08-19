# uv2nix and friends are threaded in from the flake (precedent: tools/ibkr-cli).
# The workspace root is this directory: pyproject.toml and uv.lock live here,
# never at the repository root.
{ lib
, callPackage
, writeShellApplication
, python3
, pyproject-nix
, uv2nix
, pyproject-build-systems
, gws
, freeagent
, safe-op
}:

let
  workspace = uv2nix.lib.workspace.loadWorkspace {
    workspaceRoot = ./.;
  };

  overlay = workspace.mkPyprojectOverlay {
    sourcePreference = "wheel";
  };

  pythonSet = (callPackage pyproject-nix.build.packages { python = python3; }).overrideScope
    (lib.composeManyExtensions [
      pyproject-build-systems.overlays.wheel
      overlay
    ]);

  env = pythonSet.mkVirtualEnv "op-mcp-env" workspace.deps.default;
in
# As with safe-op, `op` is deliberately NOT in runtimeInputs: the rare
# refresh-token write-back calls bare `op item edit`, which must resolve to the
# ambient 1Password wrapper at /run/wrappers/bin/op, not a nix-pinned copy.
# safe-op, gws and freeagent ARE pinned: the server execs them with the token
# injected via env, exactly as op-gws/op-freeagent do.
writeShellApplication {
  name = "op-mcp";
  runtimeInputs = [ env gws freeagent safe-op ];
  text = ''
    exec python -m op_mcp "$@"
  '';

  meta = {
    description = "Presence-scoped MCP service for the 1Password-backed OAuth CLIs";
    longDescription = ''
      A long-lived MCP server that reads OAuth credentials from 1Password once at
      start (while a human is present to authorize the desktop app), then serves
      Google Workspace and FreeAgent tool calls over a peer-verified Unix socket.
      Reads execute directly; writes become on-disk plans a human reviews and runs
      in a terminal. Tokens live only in server memory and no tool ever returns
      one.
    '';
    mainProgram = "op-mcp";
    license = lib.licenses.mit;
    # SO_PEERCRED and the /proc ancestry walk are Linux-only.
    platforms = lib.platforms.linux;
  };
}
