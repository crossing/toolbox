{ lib, pkgs, namespace, ... }:

# Unit tests for the local patches, run by the patched package's own interpreter so they
# exercise the code that ships rather than an unpatched checkout.
let
  python = "${pkgs.${namespace}.ibkr-cli.passthru.env}/bin/python";
in
pkgs.runCommand "check-ibkr-cli"
{
  meta.platforms = lib.platforms.linux;
}
  ''
    export HOME=$TMPDIR
    for test in ${../../tools/ibkr-cli/tests}/test-*.py; do
      echo "--- ibkr-cli: $(basename "$test") ---"
      ${python} "$test"
    done
    touch $out
  ''
