{
  description = "crossing/toolbox -- agent-facing command-line tools";

  # Deliberately minimal. This flake is an input to home-ops, which runs an unattended
  # weekly `nix flake update`, so every input here is something that can break a machine
  # with no human in the loop. flake-utils is avoidable -- lib.genAttrs does the same job
  # in three lines -- and it cannot express per-package system sets, which this repo
  # needs once the Linux-only IBKR tools land.
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      allSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];

      forAll = systems: f: lib.genAttrs systems f;

      pkgsFor = system: import nixpkgs {
        inherit system;
        overlays = [ self.overlays.default ];
      };
    in
    {
      # The contract home-ops consumes. Exposing an overlay (rather than only `packages`)
      # matches how home-ops surfaces every other flake input, and lets consumers write
      # `pkgs.safe-op` instead of threading `inputs` and `system` through each module.
      #
      # Attributes are lazy, so a darwin consumer never evaluates a Linux-only tool.
      overlays.default = final: _prev: {
        safe-op = final.callPackage ./tools/safe-op/package.nix { };
        op-oauth2c = final.callPackage ./tools/op-oauth2c/package.nix { };

        toolbox-skills = final.callPackage ./nix/skills.nix {
          tools = [
            { name = "safe-op"; skill = ./tools/safe-op/SKILL.md; }
            { name = "op-oauth2c"; skill = ./tools/op-oauth2c/SKILL.md; }
          ];
        };
      };

      packages = forAll allSystems (system:
        let pkgs = pkgsFor system; in
        {
          inherit (pkgs) safe-op op-oauth2c toolbox-skills;
          # safe-cli had no packages.default, so `nix run github:crossing/toolbox` errored.
          default = pkgs.safe-op;
        });

      # Neither predecessor repo wired its tests into `nix flake check`, so both shipped
      # suites that nothing ever ran. Everything under tools/*/tests/ runs here.
      checks = forAll allSystems (system:
        import ./nix/checks.nix {
          pkgs = pkgsFor system;
          inherit lib self system;
        });

      devShells = forAll allSystems (system:
        let pkgs = pkgsFor system; in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bash
              pkgs.shellcheck
              pkgs.shfmt
              pkgs.jq
              pkgs.oauth2c
              # sops + age are here for the recovery-key verification documented in
              # docs/conventions.md; neither is on PATH by default on these machines.
              pkgs.sops
              pkgs.age
              pkgs.nixpkgs-fmt
            ];
            shellHook = ''
              echo "toolbox: $(ls tools | tr '\n' ' ')"
            '';
          };
        });

      formatter = forAll allSystems (system: (pkgsFor system).nixpkgs-fmt);
    };
}
