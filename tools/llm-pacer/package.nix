{ lib, buildGoModule }:

buildGoModule rec {
  pname = "llm-pacer";
  version = "0.1.0";

  # This nested module intentionally excludes the repository root Go module and
  # every other tool's sources and dependencies.
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./go.mod
      ./main.go
      ./opencode-plugin.js
      (lib.fileset.fileFilter (file: file.hasExt "go") ./internal)
    ];
  };

  vendorHash = null;
  subPackages = [ "." ];

  ldflags = [
    "-s"
    "-w"
    "-X github.com/crossing/toolbox/tools/llm-pacer/internal/cli.Version=${version}"
  ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    go test -count=1 ./...
    runHook postCheck
  '';
  env.CGO_ENABLED = 0;

  meta = {
    description = "Queue and pace OpenAI-compatible requests for rate-limited LLM providers";
    longDescription = ''
      A loopback-only, OpenAI-compatible reverse proxy with local authentication,
      bounded FIFO admission, no-burst request pacing, upstream concurrency limits,
      conservative retries, adaptive slowdown, model discovery, and streaming.
    '';
    mainProgram = "llm-pacer";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
