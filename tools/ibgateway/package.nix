{ lib, fetchurl, stdenvNoCC, unzip, writeShellApplication, symlinkJoin, makeDesktopItem, podman, coreutils, findutils, gnused, xvfb-run }:

let
  ibcVersion = "3.24.1";
  ibgatewayVersion = "10.48";
  ibgatewayInstaller = fetchurl {
    name = "ibgateway-${ibgatewayVersion}-standalone-linux-x64.sh";
    url = "https://download2.interactivebrokers.com/installers/ibgateway/latest-standalone/ibgateway-latest-standalone-linux-x64.sh";
    # Refreshed 2026-07-27. The URL above is a rolling `latest-standalone`, so IB
    # replaces the bytes under it without notice and this hash breaks each time --
    # it is a reminder to pin a versioned URL, not a one-off. The replacement
    # differs by ~1.7 KiB on 336 MiB and carries the same internal version strings,
    # i.e. a repack rather than a new release.
    hash = "sha256-eRq+EllMDZyHNnaf2O5jaIYbDRprcOESdbMt7f7BZpI=";
  };
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
    runtimeInputs = [ podman coreutils findutils gnused xvfb-run ];
    text = builtins.readFile ./wrapper.sh;
    runtimeEnv = {
      DOCKERFILE = ./Dockerfile;
      IBC_DIR = ibc;
      IBC_VERSION = ibcVersion;
      IBGATEWAY_INSTALLER = ibgatewayInstaller;
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
