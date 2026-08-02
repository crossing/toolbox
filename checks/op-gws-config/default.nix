{ inputs, pkgs, stdenv, ... }:

# Guards the public configuration interface: withConfig must actually bake the
# consumer's accounts into the shipped script. Snowfall's makeOverridable shadowed
# .override once and the result was a silently unconfigured wrapper.
let
  configured = inputs.self.packages.${stdenv.hostPlatform.system}.op-gws.withConfig {
    accounts = { probe = "probe-item"; };
    accountNotes = { probe = "probe note"; };
    defaultAccount = "probe";
  };

  configuredFreeagent = inputs.self.packages.${stdenv.hostPlatform.system}.op-freeagent.withConfig {
    item = "probe-freeagent-item";
  };
in
pkgs.runCommand "check-op-gws-config" { } ''
  grep -q 'OP_GWS_ITEMS:=probe=probe-item' ${configured}/bin/op-gws
  grep -q 'OP_GWS_ACCOUNT_NOTES:=probe=probe note' ${configured}/bin/op-gws
  grep -q 'OP_GWS_DEFAULT_ACCOUNT:=probe' ${configured}/bin/op-gws
  grep -q 'OP_FREEAGENT_ITEM:=probe-freeagent-item' ${configuredFreeagent}/bin/op-freeagent
  touch "$out"
''
