{ lib, runCommand, ... }:

# Collect every agent-facing SKILL.md into one directory shaped like
# ~/.agents/skills, so consumers can install the skills as one package.
let
  tools = [
    { name = "safe-op"; skill = ../../tools/safe-op/SKILL.md; }
    { name = "op-oauth2c"; skill = ../../tools/op-oauth2c/SKILL.md; }
    { name = "op-gws"; skill = ../../tools/op-gws/SKILL.md; }
    { name = "op-gws-onboard"; skill = ../../tools/op-gws-onboard/SKILL.md; }
    { name = "patch-gws-skills"; skill = ../../tools/patch-gws-skills/SKILL.md; }
    { name = "freeagent"; skill = ../../tools/freeagent/SKILL.md; }
    { name = "op-freeagent"; skill = ../../tools/op-freeagent/SKILL.md; }
    { name = "ibkr-local"; skill = ../../tools/ibkr-local/SKILL.md; }
    { name = "ibkr-x11"; skill = ../../tools/ibkr-x11/SKILL.md; }
    { name = "op-mcp"; skill = ../../tools/op-mcp/SKILL.md; }
    { name = "whatsapp-bridge"; skill = ../../tools/whatsapp-bridge/SKILL.md; }
    { name = "whatsapp-mcp-server"; skill = ../../tools/whatsapp-mcp-server/SKILL.md; }
  ];
in
runCommand "toolbox-skills" { } ''
  mkdir -p "$out"
  ${lib.concatMapStringsSep "\n" (tool: ''
    mkdir -p "$out/${tool.name}"
    cp ${tool.skill} "$out/${tool.name}/SKILL.md"
  '') tools}
''
