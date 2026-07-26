{ pkgs }:

{
  mkToolTest =
    { name
    , src
    , tests
    , extraInputs ? [ ]
    , meta ? { }
    }:
    pkgs.runCommand "check-${name}"
      {
        nativeBuildInputs = [ pkgs.bash pkgs.coreutils pkgs.gnugrep ] ++ extraInputs;
        inherit meta;
      }
      ''
        export TOOL_SRC=${src}
        export HOME=$TMPDIR
        ${pkgs.lib.concatMapStringsSep "\n" (test: ''
          echo "--- ${name}: ${baseNameOf test} ---"
          bash ${test}
        '') tests}
        touch $out
      '';
}
