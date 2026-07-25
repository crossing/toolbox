{ lib, runCommand, tools }:

# Collects every tools/<name>/SKILL.md into one directory shaped like ~/.agents/skills,
# so a consumer can install them all with a single package rather than tracking each
# tool by hand:
#
#   home.file.".agents/skills".source = toolbox.packages.${system}.toolbox-skills;
#
# home-ops deliberately keeps ~/.agents/skills mutable, so it may prefer to copy rather
# than symlink. Either way the point is that a skill ships with its tool and cannot
# drift out of sync with it.
runCommand "toolbox-skills" { } ''
  mkdir -p "$out"
  ${lib.concatMapStringsSep "\n" (t: ''
    mkdir -p "$out/${t.name}"
    cp ${t.skill} "$out/${t.name}/SKILL.md"
  '') tools}
''
