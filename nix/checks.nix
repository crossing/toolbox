{ pkgs, lib, self, system }:

let
  # Runs a tool's test suite against its source in the store. TOOL_SRC is what lets the
  # test scripts find the tool without depending on cwd -- see the header of any
  # tools/*/tests/*.sh. The tool's own package is on PATH so tests can exercise the
  # built binary where they want to.
  mkToolTest = { name, src, tests, extraInputs ? [ ] }:
    pkgs.runCommand "check-${name}"
      {
        nativeBuildInputs = [ pkgs.bash pkgs.coreutils pkgs.gnugrep ] ++ extraInputs;
      }
      ''
        export TOOL_SRC=${src}
        export HOME=$TMPDIR
        ${lib.concatMapStringsSep "\n" (t: ''
          echo "--- ${name}: ${baseNameOf t} ---"
          bash ${t}
        '') tests}
        touch $out
      '';

  # Guards the .gitignore footgun that already cost this project a file: freeagent-cli's
  # bare `freeagent-cli` pattern was unanchored, so it silently ignored
  # .agents/skills/freeagent-cli/SKILL.md and the file never reached version control.
  # In a monorepo the same shape would swallow an entire tools/<name>/ directory.
  noIgnoredToolFiles = pkgs.runCommand "check-no-ignored-tool-files"
    { nativeBuildInputs = [ pkgs.git ]; } ''
    cp -r ${self} repo && chmod -R +w repo && cd repo
    # `git status --ignored` needs a repo; the flake source has no .git, so make one.
    git init -q . && git add -A 2>/dev/null || true
    if git status --porcelain --ignored 2>/dev/null | grep '^!!' | grep -q '^!! tools/'; then
      echo "ERROR: files under tools/ are gitignored:"
      git status --porcelain --ignored | grep '^!! tools/'
      echo "Never use bare, unanchored names in .gitignore -- anchor them with a leading /."
      exit 1
    fi
    touch $out
  '';

  shellcheckAll = pkgs.runCommand "check-shellcheck"
    { nativeBuildInputs = [ pkgs.shellcheck ]; } ''
    # writeShellApplication already shellchecks each tool's own script at build time;
    # this covers the test scripts, which are otherwise never linted.
    find ${self}/tools -name '*.sh' -print0 | xargs -0 shellcheck --severity=warning
    touch $out
  '';
in
{
  safe-op = mkToolTest {
    name = "safe-op";
    src = ../tools/safe-op;
    tests = [ ../tools/safe-op/tests/test-safe-op.sh ];
    extraInputs = [ self.packages.${system}.safe-op ];
  };

  op-oauth2c = mkToolTest {
    name = "op-oauth2c";
    src = ../tools/op-oauth2c;
    tests = [ ../tools/op-oauth2c/tests/test-op-oauth2c.sh ];
    extraInputs = [ pkgs.jq self.packages.${system}.op-oauth2c ];
  };

  no-ignored-tool-files = noIgnoredToolFiles;
  shellcheck = shellcheckAll;

  # Runs `go test ./...` for the whole module by reusing the freeagent derivation with
  # checks turned on, so the Go suite is gated the same way the bash ones are. Building
  # the package alone would not run tests -- buildGoModule skips them by default here
  # only because we never asked; making it explicit means a broken test fails the flake.
  go-tests = self.packages.${system}.freeagent.overrideAttrs (_: {
    pname = "check-go-tests";
    doCheck = true;
    subPackages = null; # test every package, not just the built binary
  });
}
