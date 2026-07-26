{ inputs, pkgs, ... }:

pkgs.runCommand "check-shellcheck"
{ nativeBuildInputs = [ pkgs.shellcheck ]; }
  ''
    find ${inputs.self}/tools -name '*.sh' -print0 \
      | xargs -0 shellcheck --severity=warning
    touch $out
  ''
