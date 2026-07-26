# uv2nix and friends are threaded in from the flake rather than pulled off an `inputs`
# attrset, so this file has no idea it lives in a flake at all.
{ lib
, callPackage
, runCommand
, applyPatches
, fetchFromGitHub
, writeShellApplication
, python3
, pyproject-nix
, uv2nix
, pyproject-build-systems
}:

let
  # Read metadata from metadata.json (in store after git add)
  metadata = lib.importJSON ./metadata.json;

  src = fetchFromGitHub {
    owner = metadata.owner;
    repo = metadata.repo;
    rev = metadata.rev;
    hash = metadata.narHash;
  };

  # Combine src with local uv.lock - need to put uv.lock inside src directory
  src-with-lock = runCommand "ibkr-cli-src" { } ''
    mkdir -p $out
    cp -r ${src}/* $out/
    cp ${./uv.lock} $out/uv.lock
  '';

  patched-src-with-lock = applyPatches {
    src = src-with-lock;
    patches = [ ./patches/position-data.patch ];
  };

  workspace = uv2nix.lib.workspace.loadWorkspace {
    workspaceRoot = patched-src-with-lock;
  };

  overlay = workspace.mkPyprojectOverlay {
    sourcePreference = "wheel";
  };

  python = python3;

  pythonSet = (callPackage pyproject-nix.build.packages { inherit python; }).overrideScope (lib.composeManyExtensions [
    pyproject-build-systems.overlays.wheel
    overlay
  ]);

  env = pythonSet.mkVirtualEnv "ibkr-cli-env" workspace.deps.default;

in
writeShellApplication {
  name = "ibkr";
  runtimeInputs = [ env ];
  text = ''
    exec python -m ibkr_cli.app "$@"
  '';

  # Keep this grouped with the Gateway-backed IBKR tools. The public flake has
  # intentionally never exported any of them on Darwin.
  meta.platforms = lib.platforms.linux;
}
