#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/xdg"
DATA="$TMP/data"
A="$TMP/project-a"
URL="file://$DATA"
CLONE="$XDG_DATA_HOME/capshelf/data/localhost$DATA"

mkdir -p "$HOME" "$DATA/skills/hello" "$A"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v1' > "$DATA/skills/hello/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"

# --- init from a remote data repo URL clones into the managed location ---
(cd "$A" && "${CLI[@]}" init --data "$URL" > "$TMP/init.txt")
assert_fixed_contains 'cloned data repo:' "$TMP/init.txt"
assert_fixed_contains "$URL" "$TMP/init.txt"
assert_fixed_contains 'bound project data repo:' "$TMP/init.txt"
test -d "$CLONE/.git"
test -f "$CLONE/skills/hello/SKILL.md"

# --- local.json binds the managed clone; a machine-local file:// URL is not
# --- recorded as the committed upstream
assert_fixed_contains "\"dataRepo\": \"$CLONE\"" "$A/.capshelf/local.json"
assert_fixed_not_contains 'dataRepoUpstream' "$A/.capshelf/capshelf.json"

# --- data-path resolves to the managed clone ---
(cd "$A" && "${CLI[@]}" data-path > "$TMP/data-path.txt")
test "$(cat "$TMP/data-path.txt")" = "$CLONE"
(cd "$A" && "${CLI[@]}" data-path --json > "$TMP/data-path.json")
assert_fixed_contains "\"path\": \"$CLONE\"" "$TMP/data-path.json"
assert_fixed_contains '"upstream": null' "$TMP/data-path.json"

# --- add installs from the clone, not the original remote ---
(cd "$A" && "${CLI[@]}" add skills/hello --json >/dev/null)
assert_fixed_contains 'hello v1' "$A/.agents/skills/hello/SKILL.md"
SOURCE_COMMIT="$(git -C "$CLONE" log -1 --format=%H -- skills/hello)"
assert_contains "$SOURCE_COMMIT" "$A/.capshelf/capshelf.lock.json"

# --- promote commits to the local clone and prints push guidance ---
configure_git_user "$CLONE"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v2 promoted' > "$A/.agents/skills/hello/SKILL.md"
(cd "$A" && "${CLI[@]}" promote skills/hello -m 'promote hello v2' > "$TMP/promote.txt")
assert_fixed_contains 'committed to local data repo:' "$TMP/promote.txt"
assert_fixed_contains "$CLONE" "$TMP/promote.txt"
assert_fixed_contains 'to share upstream:' "$TMP/promote.txt"
assert_fixed_contains 'git push' "$TMP/promote.txt"
assert_fixed_contains 'hello v2 promoted' "$CLONE/skills/hello/SKILL.md"
PROMOTE_COMMIT="$(git -C "$CLONE" log -1 --format=%H -- skills/hello)"
assert_contains "$PROMOTE_COMMIT" "$A/.capshelf/capshelf.lock.json"

# --- nothing was pushed: the original remote stays at the baseline commit ---
if git -C "$DATA" cat-file -e "$PROMOTE_COMMIT^{commit}" 2>/dev/null; then
  echo "expected promote commit to stay local to the clone"
  exit 1
fi
assert_fixed_contains 'hello v1' "$DATA/skills/hello/SKILL.md"

echo "✓ smoke-bootstrap ok ($TMP)"
