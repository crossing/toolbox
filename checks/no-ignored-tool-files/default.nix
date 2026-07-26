{ inputs, pkgs, ... }:

# The flake source has no .git directory, so initialize a temporary repository before
# asking Git whether an unanchored ignore rule swallowed anything under tools/.
pkgs.runCommand "check-no-ignored-tool-files"
{ nativeBuildInputs = [ pkgs.git ]; }
  ''
    cp -r ${inputs.self} repo && chmod -R +w repo && cd repo
    git init -q . && git add -A 2>/dev/null || true
    if git status --porcelain --ignored 2>/dev/null | grep '^!!' | grep -q '^!! tools/'; then
      echo "ERROR: files under tools/ are gitignored:"
      git status --porcelain --ignored | grep '^!! tools/'
      echo "Never use bare, unanchored names in .gitignore -- anchor them with a leading /."
      exit 1
    fi
    touch $out
  ''
