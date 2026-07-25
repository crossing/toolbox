{ lib, buildGoModule }:

buildGoModule {
  pname = "freeagent";
  version = "0.1.0";

  # Scoped with fileset rather than `src = ../..`: the Go module root is the repo root,
  # so an unscoped source would make every bash script and uv.lock in tools/ part of
  # this derivation's input hash -- editing tools/ibkr-local/order-entry.sh would
  # rebuild freeagent.
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../go.mod
      ../../go.sum
      (lib.fileset.fileFilter (f: f.hasExt "go") ../../tools)
    ];
  };

  # Unchanged from freeagent-cli: correcting the `// indirect` markers in go.mod does
  # not alter the module download set, so the vendor hash carries over.
  vendorHash = "sha256-7K17JaXFsjf163g5PXCb5ng2gYdotnZ2IDKk8KFjNj0=";

  # Names the binary after the last path element, so this must stay in step with the
  # directory name.
  subPackages = [ "tools/freeagent" ];

  # No cgo is needed and gcc is absent from the minimal build env.
  env.CGO_ENABLED = 0;

  meta = {
    description = "Operate FreeAgent (bills, bank transactions, explanations) from the CLI";
    longDescription = ''
      Built for agents rather than humans: JSON on stdout by default, `--human` only
      indents it, and API errors keep their structure instead of collapsing to a string.
      Authenticates from $FREEAGENT_ACCESS_TOKEN or --token.
    '';
    mainProgram = "freeagent";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
