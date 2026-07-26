{ inputs, lib, pkgs, ... }:

let
  stubs = { lib, ... }: {
    options = {
      assertions = lib.mkOption { type = lib.types.listOf lib.types.attrs; default = [ ]; };
      home.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
      systemd.user.services = lib.mkOption { type = lib.types.attrs; default = { }; };
      xdg.configFile = lib.mkOption { type = lib.types.attrs; default = { }; };
    };
  };

  evaluated = lib.evalModules {
    specialArgs = {
      inherit pkgs;
      system = pkgs.stdenv.hostPlatform.system;
    };
    modules = [
      stubs
      inputs.self.homeModules.llm-pacer
      {
        services.llm-pacer = {
          enable = true;
          upstreamBaseURL = "http://127.0.0.1:9999";
          upstreamCredentialRef = "op://Fake/Upstream/token";
          localCredentialRef = "op://Fake/Local/token";
          models."acme/mock-model" = {
            name = "Mock Model";
            limits = { context = 8192; output = 2048; };
            capabilities = { tool_call = false; reasoning = false; };
            modalities = { input = [ "text" ]; output = [ "text" ]; };
          };
        };
      }
    ];
  };

  failedAssertions = builtins.filter (item: !item.assertion) evaluated.config.assertions;
  invalidReferenceEvaluation = builtins.tryEval (
    let
      invalid = lib.evalModules {
        specialArgs = {
          inherit pkgs;
          system = pkgs.stdenv.hostPlatform.system;
        };
        modules = [
          stubs
          inputs.self.homeModules.llm-pacer
          {
            services.llm-pacer = {
              enable = true;
              upstreamBaseURL = "http://127.0.0.1:9999";
              upstreamCredentialRef = "fixture-not-an-op-reference";
              localCredentialRef = "op://Fake/Local/token";
              models."acme/mock-model" = { };
            };
          }
        ];
      };
    in
    invalid.config.services.llm-pacer.upstreamCredentialRef
  );
  service = evaluated.config.systemd.user.services.llm-pacer;
  plugin = evaluated.config.xdg.configFile."opencode/plugins/llm-pacer.js".text;
  unitText = lib.generators.toINI { listsAsDuplicateKeys = true; } service;
  unitFile = pkgs.writeText "llm-pacer.service" unitText;
  pluginFile = pkgs.writeText "llm-pacer.mjs" plugin;
in
assert !(inputs.self ? pkgs);
assert failedAssertions == [ ];
assert !invalidReferenceEvaluation.success;
assert service.Service.Restart == "no";
assert service.Service.LimitCORE == 0;
assert service.Unit.X-SwitchMethod == "keep-old";
assert !(service ? Install);
assert lib.hasInfix ''env: ["LLM_PACER_API_KEY"]'' plugin;
assert !(lib.hasInfix "options.apiKey" plugin);
pkgs.runCommand "check-llm-pacer-home-module"
{
  nativeBuildInputs = [ pkgs.nodejs pkgs.systemd ] ++ evaluated.config.home.packages;
  meta.platforms = lib.platforms.linux;
}
  ''
    mkdir -p home runtime
    cp ${unitFile} llm-pacer.service
    printf '[Unit]\nDescription=Verifier basic target\n' > basic.target
    # Give the offline user-unit verifier writable lookup state inside the Nix
    # sandbox. It does not connect to a running user manager.
    HOME="$PWD/home" XDG_RUNTIME_DIR="$PWD/runtime" SYSTEMD_UNIT_PATH="$PWD" \
      systemd-analyze verify --user "$PWD/llm-pacer.service"
    node --check ${pluginFile}
    touch "$out"
  ''
