{ lib, pkgs, ... }:

# Typechecks and unit-tests the Cloudflare Workers npm workspace without
# network access: npm ci replays the committed lockfile against the
# importNpmLock tarball cache (the workspace-aware path; buildNodeModules
# alone skips workspace dependencies), so the check fails loudly if the
# lockfile drifts from the manifests.
#
# nodejs is pinned to a major on purpose: home-ops runs an unattended weekly
# `nix flake update`, and a silent default-node major bump is exactly the
# kind of breakage that would land with no human present.
let
  nodejs = pkgs.nodejs_24;
  src = lib.fileset.toSource {
    root = ../../tools/mcp-workers;
    fileset = lib.fileset.difference ../../tools/mcp-workers (
      lib.fileset.unions [
        (lib.fileset.maybeMissing ../../tools/mcp-workers/node_modules)
        (lib.fileset.maybeMissing ../../tools/mcp-workers/shared/node_modules)
        (lib.fileset.maybeMissing ../../tools/mcp-workers/freeagent/node_modules)
        (lib.fileset.maybeMissing ../../tools/mcp-workers/freeagent/.wrangler)
      ]
    );
  };
in
pkgs.buildNpmPackage {
  pname = "check-mcp-workers";
  version = "0";
  inherit src nodejs;

  npmDeps = pkgs.importNpmLock { npmRoot = src; };
  npmConfigHook = pkgs.importNpmLock.npmConfigHook;

  dontNpmBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    echo "--- mcp-workers: typecheck ---"
    npm run typecheck
    echo "--- mcp-workers: vitest ---"
    npm test
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    touch $out
    runHook postInstall
  '';

  meta.platforms = lib.platforms.linux;
}
