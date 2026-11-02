#!/bin/bash
# The plugin's whole check: manifests parse, skill names match their directories, no
# references to the author's machine in runtime files, and the node tests of both skills.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { echo "FAIL: $1"; exit 1; }

node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json","utf8"))' || fail "plugin.json does not parse"
node -e 'JSON.parse(require("fs").readFileSync(".claude-plugin/marketplace.json","utf8"))' || fail "marketplace.json does not parse"
[ "$(node -p 'require("./.claude-plugin/plugin.json").name')" = leaf ] || fail "plugin name is not leaf"
echo "ok: manifests"

shopt -s nullglob
for dir in skills/*/; do
  name=$(basename "$dir")
  grep -qx "name: $name" "$dir/SKILL.md" || fail "$dir/SKILL.md frontmatter name is not $name"
done
echo "ok: skill names"

# Runtime files must not refer to the author's machine. The bundle id com.slavhurmanau.leaf
# is Leaf's identifier and is allowed; this script is excluded from the path scan since it
# names the pattern. Pattern pieces are assembled so this file matches neither grep.
H='/Users'; P="$H/"
if grep -rniE 'slav' skills README.md 2>/dev/null | grep -v 'com.slavhurmanau.leaf' | grep -q .; then fail "author reference in skills/ or README.md"; fi
if grep -rn "$P" skills README.md 2>/dev/null | grep -q .; then fail "machine path in skills/ or README.md"; fi
if grep -rn "$P" scripts --exclude=test.sh 2>/dev/null | grep -q .; then fail "machine path in scripts/"; fi
echo "ok: no machine references"

tests=(skills/*/test/*.test.mjs)
if [ ${#tests[@]} -eq 0 ]; then echo "no tests yet"; exit 0; fi
node --test "${tests[@]}" 2>&1 | grep -E "^# (pass|fail)" | tee /dev/stderr | grep -q "^# fail 0" || fail "node tests"
echo "ok: node tests (${#tests[@]} files)"
