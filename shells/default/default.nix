{ mkShell
, bash
, shellcheck
, shfmt
, jq
, oauth2c
, sops
, age
, nixpkgs-fmt
, ...
}:

mkShell {
  packages = [
    bash
    shellcheck
    shfmt
    jq
    oauth2c
    sops
    age
    nixpkgs-fmt
  ];

  shellHook = ''
    echo "toolbox: $(ls tools | tr '\n' ' ')"
  '';
}
