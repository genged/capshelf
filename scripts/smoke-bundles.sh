#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

# --- 1. data repo: two skills, two settings fragments, one mcp fragment;
#        bundles/go-backend.yml includes five of them; skills/quick-review
#        conflicts-with a bundle member ---
mkdir -p "$HOME" \
  "$DATA/skills/security-review" \
  "$DATA/skills/go-test-writer" \
  "$DATA/skills/quick-review" \
  "$DATA/settings/permissions-base" \
  "$DATA/settings/permissions-go" \
  "$DATA/mcp/github" \
  "$DATA/bundles" \
  "$A"
printf '%s\n' '---' 'name: security-review' '---' '' 'Deep audit.' \
  > "$DATA/skills/security-review/SKILL.md"
printf '%s\n' 'write go tests' > "$DATA/skills/go-test-writer/SKILL.md"
printf '%s\n' 'quick review' > "$DATA/skills/quick-review/SKILL.md"
printf '%s\n' 'conflicts-with: [skills/security-review]' \
  > "$DATA/skills/quick-review/.capshelf.yml"
# SHARED proves bundle-order fragment merge: last fragment wins.
printf '%s\n' '{ "env": { "BASE": "1", "SHARED": "base" } }' \
  > "$DATA/settings/permissions-base/settings.json"
printf '%s\n' '{ "env": { "GO": "1", "SHARED": "go" } }' \
  > "$DATA/settings/permissions-go/settings.json"
printf '%s\n' '{ "mcpServers": { "github": { "command": "github-mcp" } } }' \
  > "$DATA/mcp/github/claude.json"
printf '%s\n' \
  'description: Everything a Go backend service needs.' \
  'tags: [go, backend]' \
  'includes:' \
  '  skills:   [security-review, go-test-writer]' \
  '  settings: [permissions-base, permissions-go]' \
  '  mcp:      [github]' \
  > "$DATA/bundles/go-backend.yml"
git -C "$DATA" init -q --initial-branch=main
configure_git_user "$DATA"
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
git -C "$A" init -q --initial-branch=main

# --- 2. init; ls shows the bundles/ section; ls --json parses and has it ---
(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$A" && "${CLI[@]}" ls > "$TMP/ls.txt")
assert_fixed_contains 'bundles/  (from' "$TMP/ls.txt"
assert_fixed_contains 'go-backend' "$TMP/ls.txt"
assert_fixed_contains '2 skills · 2 settings · 1 mcp' "$TMP/ls.txt"
(cd "$A" && "${CLI[@]}" ls --json > "$TMP/ls.json")
python3 -m json.tool < "$TMP/ls.json" >/dev/null
assert_fixed_contains '"bundles"' "$TMP/ls.json"

# --- 3. show bundles/go-backend: all members listed, none installed ---
(cd "$A" && "${CLI[@]}" show bundles/go-backend > "$TMP/show.txt")
for member in skills/security-review skills/go-test-writer \
  settings/permissions-base settings/permissions-go mcp/github; do
  assert_fixed_contains "$member" "$TMP/show.txt"
done
assert_fixed_contains 'not installed' "$TMP/show.txt"
assert_fixed_not_contains 'installed (project)' "$TMP/show.txt"

# --- 4. add bundles/go-backend: five items, strict-clean, bundle-order merge ---
(cd "$A" && "${CLI[@]}" add bundles/go-backend > "$TMP/add.txt")
assert_fixed_contains '✓ bundle go-backend → 5 added, 0 already installed' "$TMP/add.txt"
(cd "$A" && "${CLI[@]}" ls --here > "$TMP/here.txt")
for member in skills/security-review skills/go-test-writer \
  settings/permissions-base settings/permissions-go mcp/github; do
  assert_fixed_contains "$member" "$TMP/here.txt"
done
assert_fixed_not_contains 'go-backend' "$TMP/here.txt"
(cd "$A" && "${CLI[@]}" status --strict >/dev/null)
# permissions-go is listed after permissions-base, so its SHARED value wins.
assert_fixed_contains '"SHARED": "go"' "$A/.claude/settings.json"
assert_fixed_contains '"BASE": "1"' "$A/.claude/settings.json"

# --- 5. re-run: converges, lock byte-identical (no pin bump) ---
cp "$A/.capshelf/capshelf.lock.json" "$TMP/lock-after-add.json"
(cd "$A" && "${CLI[@]}" add bundles/go-backend > "$TMP/rerun.txt")
assert_fixed_contains '✓ bundle go-backend → 0 added, 5 already installed' "$TMP/rerun.txt"
if ! cmp -s "$TMP/lock-after-add.json" "$A/.capshelf/capshelf.lock.json"; then
  echo "expected lock to be byte-identical after bundle re-run"
  exit 1
fi

# --- 6. conflicts: single add exits 3 (metadata spec), and a bundle with the
#        conflicting member refuses all-or-nothing with the lock untouched ---
set +e
(cd "$A" && "${CLI[@]}" add skills/quick-review > "$TMP/conflict.txt" 2>&1)
CONFLICT_EXIT=$?
set -e
if [ "$CONFLICT_EXIT" -ne 3 ]; then
  echo "expected conflicting add to exit 3, got $CONFLICT_EXIT"
  exit 1
fi
assert_fixed_contains 'conflicts with installed skills/security-review' "$TMP/conflict.txt"
printf '%s\n' \
  'includes:' \
  '  skills: [quick-review, go-test-writer]' \
  > "$DATA/bundles/review-set.yml"
git -C "$DATA" add bundles/review-set.yml
git -C "$DATA" commit -qm 'review-set bundle'
set +e
(cd "$A" && "${CLI[@]}" add bundles/review-set > "$TMP/bundle-conflict.txt" 2>&1)
BUNDLE_CONFLICT_EXIT=$?
set -e
if [ "$BUNDLE_CONFLICT_EXIT" -ne 3 ]; then
  echo "expected conflicting bundle add to exit 3, got $BUNDLE_CONFLICT_EXIT"
  exit 1
fi
assert_fixed_contains 'not installing bundle review-set' "$TMP/bundle-conflict.txt"
assert_fixed_contains 'no changes were made' "$TMP/bundle-conflict.txt"
if ! cmp -s "$TMP/lock-after-add.json" "$A/.capshelf/capshelf.lock.json"; then
  echo "expected lock to be byte-identical after refused bundle"
  exit 1
fi

# --- 7. bundle grows: the new member item is committed, the bundle YAML is
#        deliberately left uncommitted (working-tree read) ---
mkdir -p "$DATA/skills/extra"
printf '%s\n' 'extra skill' > "$DATA/skills/extra/SKILL.md"
git -C "$DATA" add skills/extra
git -C "$DATA" commit -qm 'extra skill'
printf '%s\n' \
  'description: Everything a Go backend service needs.' \
  'tags: [go, backend]' \
  'includes:' \
  '  skills:   [security-review, go-test-writer, extra]' \
  '  settings: [permissions-base, permissions-go]' \
  '  mcp:      [github]' \
  > "$DATA/bundles/go-backend.yml"
(cd "$A" && "${CLI[@]}" add bundles/go-backend > "$TMP/grow.txt")
assert_fixed_contains '✓ bundle go-backend → 1 added, 5 already installed' "$TMP/grow.txt"
assert_fixed_contains '+ skills/extra' "$TMP/grow.txt"
git -C "$DATA" add bundles/go-backend.yml
git -C "$DATA" commit -qm 'grow go-backend bundle'
(cd "$A" && "${CLI[@]}" status --strict >/dev/null)

# --- 8. errors: missing bundle exits 2; a corrupted bundle degrades on ls
#        (stderr warning, exit 0) but refuses on add (exit 3) ---
set +e
(cd "$A" && "${CLI[@]}" add bundles/nope >/dev/null 2>&1)
MISSING_EXIT=$?
set -e
if [ "$MISSING_EXIT" -ne 2 ]; then
  echo "expected missing bundle to exit 2, got $MISSING_EXIT"
  exit 1
fi
printf '%s\n' '[broken' > "$DATA/bundles/go-backend.yml"
(cd "$A" && "${CLI[@]}" ls > "$TMP/ls-broken.txt" 2> "$TMP/ls-broken-err.txt")
assert_fixed_contains 'go-backend' "$TMP/ls-broken.txt"
assert_fixed_contains 'invalid YAML' "$TMP/ls-broken-err.txt"
set +e
(cd "$A" && "${CLI[@]}" add bundles/go-backend > "$TMP/add-broken.txt" 2>&1)
BROKEN_EXIT=$?
set -e
if [ "$BROKEN_EXIT" -ne 3 ]; then
  echo "expected malformed bundle add to exit 3, got $BROKEN_EXIT"
  exit 1
fi
assert_fixed_contains 'invalid YAML' "$TMP/add-broken.txt"

echo "✓ smoke-bundles ok ($TMP)"
