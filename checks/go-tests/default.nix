{ inputs, lib, stdenv, ... }:

inputs.self.packages.${stdenv.hostPlatform.system}.freeagent.overrideAttrs (old: {
  pname = "check-go-tests";
  doCheck = true;
  subPackages = null;
  meta = (old.meta or { }) // { platforms = lib.platforms.linux; };
})
