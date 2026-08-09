{ lib, writeShellApplication, coreutils, gnused, gawk, procps, xdotool, imagemagick }:

writeShellApplication {
  name = "ibkr-x11";
  runtimeInputs = [ coreutils gnused gawk procps xdotool imagemagick ];
  text = builtins.readFile ./ibkr-x11.sh;

  meta = {
    description = "Attach xdotool/import to a headless IBKR Gateway profile's display";
    longDescription = ''
      Resolves the private Xvfb DISPLAY and XAUTHORITY of an ibkr-gateway-<profile>
      podman process and runs xdotool or ImageMagick's import against it, so a stuck
      login dialog can be inspected and driven without hand-assembling env prefixes.
    '';
    mainProgram = "ibkr-x11";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
