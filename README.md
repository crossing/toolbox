# toolbox

Command-line tools built for AI agents to operate: machine-readable by default,
structured errors, and guardrails around the mistakes agents actually make.

## Tools

| Tool | What it does |
|---|---|
| [`safe-op`](tools/safe-op) | 1Password CLI wrapper that refuses to print secrets to a terminal |
| [`op-oauth2c`](tools/op-oauth2c) | Runs an OAuth2 flow with 1Password-held credentials, writing tokens back |
| [`freeagent`](tools/freeagent) | Operate FreeAgent bills, bank transactions and explanations |
| [`ibkr-local`](tools/ibkr-local) | Guarded Interactive Brokers CLI — reads freely, gates order entry (Linux) |
| [`ibkr-cli`](tools/ibkr-cli) | Packaging of upstream `fatwang2/ibkr-cli`, patched and pinned (Linux) |
| [`ibgateway`](tools/ibgateway) | IB Gateway + IBC runtime, image and installer pinned (Linux) |

Each tool directory holds its source, package derivation, `SKILL.md`, and tests.
Snowfall Lib discovers the thin package entrypoints, checks, and development shell from
`packages/`, `checks/`, and `shells/` while the exported flake paths remain unchanged.

## Use

As a flake input:

```nix
{
  inputs.toolbox.url = "github:crossing/toolbox";

  # either take the overlay...
  nixpkgs.overlays = [ inputs.toolbox.overlays.default ];   # -> pkgs.safe-op

  # ...or reference packages directly
  home.packages = [ inputs.toolbox.packages.${system}.safe-op ];
}
```

Or run one without installing:

```bash
nix run github:crossing/toolbox#safe-op -- item list
```

Agent skills for every tool are collected into one package:

```nix
home.file.".agents/skills".source = inputs.toolbox.packages.${system}.toolbox-skills;
```

## Develop

```bash
nix develop
nix flake check          # runs all tool tests + shellcheck + gitignore guard
nix build .#safe-op
```

`nix flake check` is the gate. See [AGENTS.md](AGENTS.md) for conventions and
[docs/adding-a-tool.md](docs/adding-a-tool.md) for the checklist.

## License

MIT, with restrictions on use as AI training data. See [LICENSE](LICENSE).
