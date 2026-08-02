{ lib, fetchurl, stdenvNoCC, unzip, writeShellApplication, symlinkJoin, makeDesktopItem, podman, coreutils, curl, findutils, gnused, xvfb-run }:

# The IB Gateway installer is deliberately NOT fetched here. IB only serves mutable
# channel URLs (latest/stable) with no versioned archive, so a fixed-output fetch
# breaks every time IB releases. The wrapper downloads the installer at install time
# instead, with trust-on-first-use provenance and an optional sha256 pin. IBC below
# stays pinned: it has real versioned release URLs.
let
  ibcVersion = "3.24.1";
  ibc = stdenvNoCC.mkDerivation {
    pname = "ibc";
    version = ibcVersion;
    src = fetchurl {
      url = "https://github.com/IbcAlpha/IBC/releases/download/${ibcVersion}/IBCLinux-${ibcVersion}.zip";
      hash = "sha256-2Z7ijMNTnjhD+wDSjcSEwlUAawBj048ICKw+8H3Yi7g=";
    };
    patches = [ ./ibc-autorestart-builtins.patch ];
    nativeBuildInputs = [ unzip ];
    unpackPhase = ''unzip "$src"'';
    installPhase = ''
      mkdir -p "$out"
      cp -R . "$out/"
      chmod +x "$out"/*.sh "$out"/scripts/*.sh
    '';
  };
  wrapper = writeShellApplication {
    name = "ibgateway";
    runtimeInputs = [ podman coreutils curl findutils gnused xvfb-run ];
    text = builtins.readFile ./wrapper.sh;
    runtimeEnv = {
      DOCKERFILE = ./Dockerfile;
      IBC_DIR = ibc;
      IBC_VERSION = ibcVersion;
    };
  };
in
symlinkJoin {
  name = "ibgateway";
  passthru = { inherit ibc; };
  paths = [ wrapper (makeDesktopItem {
    name = "ibgateway";
    desktopName = "IB Gateway";
    genericName = "Trading Gateway";
    comment = "Interactive Brokers Gateway";
    exec = "ibgateway";
    categories = [ "Finance" ];
  }) ];
  meta = {
    description = "Interactive Brokers Gateway";
    platforms = lib.platforms.linux;
  };
}
