# Vendored fork of lharries/whatsapp-mcp's Go bridge (MIT, LICENSE.upstream).
# Local divergence from upstream: whatsmeow bumped past the 2026 context-API
# change, state paths honour WHATSAPP_STATE_DIR, and the REST port honours
# WHATSAPP_BRIDGE_PORT. go.mod still names the module `whatsapp-client`;
# the binary is renamed to match this tool.
{ lib, buildGoModule }:

buildGoModule {
  pname = "whatsapp-bridge";
  version = "0-unstable-2026-08-20";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [ ./main.go ./go.mod ./go.sum ];
  };

  vendorHash = "sha256-kXC+YWchCEk+9VduBhTRbU6sbjQIsG9BfVuF4mKWsnw=";

  # go-sqlite3 is a cgo package; without cgo the bridge builds but cannot
  # open its databases.
  env.CGO_ENABLED = "1";

  postInstall = ''
    mv $out/bin/whatsapp-client $out/bin/whatsapp-bridge
  '';

  meta = {
    description = "WhatsApp linked-device bridge: syncs messages to SQLite and serves a localhost REST API";
    mainProgram = "whatsapp-bridge";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
