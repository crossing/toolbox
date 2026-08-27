# Vendored fork of lharries/whatsapp-mcp's MCP server (MIT, LICENSE.upstream),
# restructured as an installable package. Local divergence from upstream: the
# three send tools only register with WHATSAPP_MCP_ALLOW_SEND=1, and the
# message-DB path / bridge API URL come from WHATSAPP_STATE_DIR (shared with
# whatsapp-bridge) or WHATSAPP_DB_PATH / WHATSAPP_API_URL.
#
# uv2nix and friends are threaded in from the flake.
{ lib
, callPackage
, writeShellApplication
, python3
, pyproject-nix
, uv2nix
, pyproject-build-systems
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

  env = pythonSet.mkVirtualEnv "whatsapp-mcp-server-env" workspace.deps.default;
in
# ffmpeg is deliberately NOT pinned: it is only reached by the send-gated
# voice-note conversion, which already degrades with a clear error telling the
# caller to use send_file instead.
writeShellApplication {
  name = "whatsapp-mcp-server";
  runtimeInputs = [ env ];
  text = ''
    exec python -m whatsapp_mcp_server.main "$@"
  '';

  passthru = { inherit env; };

  meta = {
    description = "MCP server over the whatsapp-bridge message store (read-only by default)";
    mainProgram = "whatsapp-mcp-server";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
