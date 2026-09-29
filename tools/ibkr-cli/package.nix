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
    patches = [
      ./patches/position-data.patch
      # --sec-type/--conid/--isin on buy, sell and bars, so a BOND (e.g. a gilt) can be
      # resolved by conId or ISIN rather than by ticker.
      ./patches/bond-contracts.patch
      # con_id on every `orders executions` row, so a fill names its instrument exactly
      # rather than by a ticker that cannot tell one gilt from another.
      ./patches/execution-contract-id.patch
      # --sec-type CASH on buy, sell and bars: a currency pair such as GBP.USD on IDEALPRO,
      # resolved by pair or conId; bars default to MIDPOINT, since FX has no TRADES history.
      ./patches/fx-contracts.patch
    ];
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

  # The virtualenv holds the patched ibkr_cli package, so checks/ibkr-cli can run the
  # Python unit tests against exactly what ships.
  passthru = { inherit env; };

  # Keep this grouped with the Gateway-backed IBKR tools. The public flake has
  # intentionally never exported any of them on Darwin.
  meta.platforms = lib.platforms.linux;
}
