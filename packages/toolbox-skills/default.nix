{ lib, runCommand, ... }:

# Collect every agent-facing SKILL.md into one directory shaped like
# ~/.agents/skills, so consumers can install the skills as one package.
let
  tools = [
    { name = "safe-op"; skill = ../../tools/safe-op/SKILL.md; }
    { name = "op-oauth2c"; skill = ../../tools/op-oauth2c/SKILL.md; }
    { name = "freeagent"; skill = ../../tools/freeagent/SKILL.md; }
    { name = "ibkr-local"; skill = ../../tools/ibkr-local/SKILL.md; }
  ];
in
runCommand "toolbox-skills" { } ''
  mkdir -p "$out"
  ${lib.concatMapStringsSep "\n" (tool: ''
    mkdir -p "$out/${tool.name}"
    cp ${tool.skill} "$out/${tool.name}/SKILL.md"
  '') tools}
''
