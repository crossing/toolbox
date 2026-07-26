{ config
, lib
, pkgs
, llmPacerPackage ? pkgs.llm-pacer
, safeOpPackage ? pkgs.safe-op
, ...
}:

let
  inherit (lib) mkEnableOption mkIf mkMerge mkOption types;

  cfg = config.services.llm-pacer;
  jsonFormat = pkgs.formats.json { };

  isOnePasswordReference = value:
    let
      parts = lib.splitString "/" value;
      path = lib.drop 2 parts;
    in
    builtins.length parts >= 5
    && builtins.elemAt parts 0 == "op:"
    && builtins.elemAt parts 1 == ""
    && lib.all (part: part != "" && !(lib.hasInfix "\n" part) && !(lib.hasInfix "\r" part)) path;

  credentialReferenceType = types.addCheck types.str isOnePasswordReference;

  settings = {
    listen = cfg.listenAddress;
    upstream_base_url = cfg.upstreamBaseURL;
    rpm = cfg.requestsPerMinute;
    max_inflight = cfg.maxInflight;
    queue_limit = cfg.queueLimit;
    max_queued_body_bytes = cfg.maxQueuedBodyBytes;
    max_request_body_bytes = cfg.maxRequestBodyBytes;
    max_retries = cfg.maxRetries;
    max_backoff = cfg.maxBackoff;
    upstream_request_timeout = cfg.upstreamRequestTimeout;
    stream_idle_timeout = cfg.streamIdleTimeout;
    connect_timeout = cfg.connectTimeout;
    min_adaptive_rpm = cfg.minAdaptiveRequestsPerMinute;
    models = cfg.models;
  };

  configFile = jsonFormat.generate "llm-pacer.json" settings;
  localBaseURL = "http://${cfg.listenAddress}/v1";
  healthURL = "http://${cfg.listenAddress}/healthz";
  upstreamCredentialRef = if cfg.upstreamCredentialRef == null then "" else cfg.upstreamCredentialRef;
  localCredentialRef = if cfg.localCredentialRef == null then "" else cfg.localCredentialRef;

  pluginText = builtins.replaceStrings
    [ "__LLM_PACER_BASE_URL__" "__LLM_PACER_STATIC_CATALOG__" ]
    [ (builtins.toJSON localBaseURL) (builtins.toJSON cfg.models) ]
    (builtins.readFile ../../../tools/llm-pacer/opencode-plugin.js);

  starterText = builtins.replaceStrings
    [
      "__LLM_PACER_UPSTREAM_CREDENTIAL_REF__"
      "__LLM_PACER_LOCAL_CREDENTIAL_REF__"
      "__LLM_PACER_HEALTH_URL__"
    ]
    [
      (lib.escapeShellArg upstreamCredentialRef)
      (lib.escapeShellArg localCredentialRef)
      (lib.escapeShellArg healthURL)
    ]
    (builtins.readFile ../../../tools/llm-pacer/llm-pacer-start.sh);

  starter = pkgs.writeShellApplication {
    name = "llm-pacer-start";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
      pkgs.systemd
      pkgs.util-linux
      cfg.package
      cfg.safeOpPackage
    ];
    text = starterText;
  };

  openCodeLauncherText = builtins.replaceStrings
    [
      "__LLM_PACER_LOCAL_CREDENTIAL_REF__"
      "__LLM_PACER_OPENCODE_COMMAND__"
    ]
    [
      (lib.escapeShellArg localCredentialRef)
      (lib.escapeShellArg cfg.openCode.command)
    ]
    (builtins.readFile ../../../tools/llm-pacer/llm-pacer-opencode.sh);

  openCodeLauncher = pkgs.writeShellApplication {
    name = "llm-pacer-opencode";
    runtimeInputs = [ cfg.package cfg.safeOpPackage ];
    text = openCodeLauncherText;
  };
in
{
  options.services.llm-pacer = {
    enable = mkEnableOption "the local request-rate pacing LLM provider";

    package = mkOption {
      type = types.package;
      default = llmPacerPackage;
      defaultText = lib.literalExpression "llmPacerPackage";
      description = "llm-pacer package used by the service and launch helpers.";
    };

    safeOpPackage = mkOption {
      type = types.package;
      default = safeOpPackage;
      defaultText = lib.literalExpression "safeOpPackage";
      description = "safe-op package used only by the interactive launch helpers.";
    };

    listenAddress = mkOption {
      type = types.str;
      default = "127.0.0.1:4000";
      description = "Literal loopback address and port on which the local provider listens.";
    };

    upstreamBaseURL = mkOption {
      type = types.str;
      default = "";
      example = "https://integrate.api.nvidia.com";
      description = ''
        Non-secret upstream URL prefix. The complete inbound /v1 path is appended,
        so omit a trailing /v1 unless the provider needs it twice.
      '';
    };

    requestsPerMinute = mkOption {
      type = types.number;
      default = 32;
      description = "Configured ceiling for globally paced outbound request starts.";
    };

    minAdaptiveRequestsPerMinute = mkOption {
      type = types.number;
      default = 1;
      description = "Minimum effective request rate after adaptive 429 slowdown.";
    };

    maxInflight = mkOption {
      type = types.ints.positive;
      default = 3;
      description = "Maximum concurrent upstream attempts, including open streams.";
    };

    queueLimit = mkOption {
      type = types.ints.positive;
      default = 128;
      description = "Maximum admitted requests, including active and backing-off requests.";
    };

    maxQueuedBodyBytes = mkOption {
      type = types.ints.positive;
      default = 256 * 1024 * 1024;
      description = "Maximum retained request-body bytes across admitted requests.";
    };

    maxRequestBodyBytes = mkOption {
      type = types.ints.positive;
      default = 16 * 1024 * 1024;
      description = "Maximum body size for one inbound request.";
    };

    maxRetries = mkOption {
      type = types.ints.positive;
      default = 12;
      description = "Maximum explicit retries after the initial upstream attempt.";
    };

    maxBackoff = mkOption {
      type = types.str;
      default = "300s";
      description = "Maximum retry delay as a Go duration string.";
    };

    upstreamRequestTimeout = mkOption {
      type = types.str;
      default = "1800s";
      description = "Maximum wait for upstream response headers as a Go duration string.";
    };

    streamIdleTimeout = mkOption {
      type = types.str;
      default = "1800s";
      description = "Maximum idle gap while reading an upstream response body.";
    };

    connectTimeout = mkOption {
      type = types.str;
      default = "30s";
      description = "TCP/TLS and local read-header timeout as a Go duration string.";
    };

    models = mkOption {
      type = types.attrsOf (types.attrsOf jsonFormat.type);
      default = { };
      example = {
        "vendor/model" = {
          name = "Vendor Model";
          limits = { context = 131072; output = 16384; };
          capabilities = { tool_call = true; reasoning = false; };
          modalities = { input = [ "text" ]; output = [ "text" ]; };
        };
      };
      description = "Authoritative model allowlist and discovery metadata.";
    };

    upstreamCredentialRef = mkOption {
      type = types.nullOr credentialReferenceType;
      default = null;
      example = "op://Private/LLM provider API key/credential";
      description = "1Password reference read interactively by llm-pacer-start.";
    };

    localCredentialRef = mkOption {
      type = types.nullOr credentialReferenceType;
      default = null;
      example = "op://Private/LLM pacer local token/credential";
      description = "1Password reference for the distinct local bearer token.";
    };

    fileDescriptorLimit = mkOption {
      type = types.ints.positive;
      default = 1024;
      description = "File-descriptor limit for queued clients and upstream connections.";
    };

    openCode = {
      enable = mkOption {
        type = types.bool;
        default = true;
        description = "Install the dynamic llm-pacer provider plugin and interactive launcher.";
      };

      command = mkOption {
        type = types.str;
        default = "opencode";
        description = "OpenCode executable name or absolute path used by llm-pacer-opencode.";
      };
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = pkgs.stdenv.hostPlatform.isLinux;
          message = "services.llm-pacer requires Linux systemd user services";
        }
        {
          assertion = cfg.upstreamBaseURL != "";
          message = "services.llm-pacer.upstreamBaseURL must be set";
        }
        {
          assertion = cfg.models != { };
          message = "services.llm-pacer.models must contain at least one model";
        }
        {
          assertion = cfg.upstreamCredentialRef != null && cfg.upstreamCredentialRef != "";
          message = "services.llm-pacer.upstreamCredentialRef must be set";
        }
        {
          assertion = cfg.localCredentialRef != null && cfg.localCredentialRef != "";
          message = "services.llm-pacer.localCredentialRef must be set";
        }
        {
          assertion = cfg.upstreamCredentialRef != cfg.localCredentialRef;
          message = "services.llm-pacer upstream and local credential references must be distinct";
        }
        {
          assertion = cfg.requestsPerMinute > 0;
          message = "services.llm-pacer.requestsPerMinute must be positive";
        }
        {
          assertion = cfg.minAdaptiveRequestsPerMinute > 0
            && cfg.minAdaptiveRequestsPerMinute <= cfg.requestsPerMinute;
          message = "services.llm-pacer.minAdaptiveRequestsPerMinute must be positive and no greater than requestsPerMinute";
        }
        {
          assertion = cfg.queueLimit <= 500;
          message = "services.llm-pacer.queueLimit must not exceed 500";
        }
        {
          assertion = cfg.maxRequestBodyBytes <= cfg.maxQueuedBodyBytes;
          message = "services.llm-pacer.maxRequestBodyBytes must not exceed maxQueuedBodyBytes";
        }
        {
          assertion = cfg.fileDescriptorLimit >= cfg.queueLimit + (2 * cfg.maxInflight) + 64;
          message = "services.llm-pacer.fileDescriptorLimit is too small for the configured queue and inflight limits";
        }
        {
          assertion = !cfg.openCode.enable || cfg.openCode.command != "";
          message = "services.llm-pacer.openCode.command must be set when OpenCode integration is enabled";
        }
      ];

      home.packages = [ cfg.package starter ]
        ++ lib.optional cfg.openCode.enable openCodeLauncher;

      systemd.user.services.llm-pacer = {
        Unit = {
          Description = "Local paced OpenAI-compatible LLM provider";
          X-SwitchMethod = "keep-old";
        };

        Service = {
          Type = "exec";
          ExecStart = "${lib.getExe cfg.package} serve --config ${configFile}";
          ExecStartPost = "${pkgs.coreutils}/bin/rm -rf -- %t/llm-pacer/credentials";
          LoadCredential = [
            "upstream-api-key:%t/llm-pacer/credentials/upstream-api-key"
            "local-api-key:%t/llm-pacer/credentials/local-api-key"
          ];
          Environment = [
            "LLM_PACER_UPSTREAM_API_KEY_FILE=%d/upstream-api-key"
            "LLM_PACER_LOCAL_API_KEY_FILE=%d/local-api-key"
          ];

          Restart = "no";
          UMask = "0077";
          TimeoutStopSec = "30s";
          LimitNOFILE = cfg.fileDescriptorLimit;
          LimitCORE = 0;
          TasksMax = 128;

          NoNewPrivileges = true;
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectSystem = "strict";
          ProtectHome = "read-only";
          InaccessiblePaths = [ "%h" ];
          ReadWritePaths = [ "-%t/llm-pacer" ];
          CapabilityBoundingSet = "";
          AmbientCapabilities = "";
          LockPersonality = true;
          MemoryDenyWriteExecute = true;
          ProtectClock = true;
          ProtectControlGroups = true;
          ProtectKernelLogs = true;
          ProtectKernelModules = true;
          ProtectKernelTunables = true;
          RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
          RestrictNamespaces = true;
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          SystemCallArchitectures = "native";
        };
      };
    }

    (mkIf cfg.openCode.enable {
      xdg.configFile."opencode/plugins/llm-pacer.js".text = pluginText;
    })
  ]);
}
