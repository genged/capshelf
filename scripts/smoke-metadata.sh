#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

# --- 1. data repo: skill A (sidecar + frontmatter), skill B (conflicts with
#        A), a bare skill, and a settings fragment required by skill A ---
mkdir -p "$HOME" \
  "$DATA/skills/security-review" \
  "$DATA/skills/quick-review" \
  "$DATA/skills/hello" \
  "$DATA/settings/permissions-base" \
  "$A"
printf '%s\n' '---' 'name: security-review' 'description: frontmatter fallback' '---' '' 'Deep audit. Check for SQL injection.' \
  > "$DATA/skills/security-review/SKILL.md"
printf '%s\n' \
  'description: Deep multi-pass security audit of changed files.' \
  'tags: [security, review]' \
  'requires:' \
  '  - settings/permissions-base' \
  > "$DATA/skills/security-review/.capshelf.yml"
printf '%s\n' '---' 'name: quick-review' '---' '' 'Quick review.' \
  > "$DATA/skills/quick-review/SKILL.md"
printf '%s\n' 'conflicts-with: [skills/security-review]' \
  > "$DATA/skills/quick-review/.capshelf.yml"
printf '%s\n' 'plain hello skill' > "$DATA/skills/hello/SKILL.md"
printf '%s\n' '{}' > "$DATA/settings/permissions-base/settings.json"
printf '%s\n' 'description: Baseline permission allowlist.' 'tags: [security]' \
  > "$DATA/settings/permissions-base/.capshelf.yml"
git -C "$DATA" init -q --initial-branch=main
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-metadata-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
git -C "$A" init -q --initial-branch=main

# --- 2. init; ls shows metadata; --tag filters; search discovers skill A ---
(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$A" && "${CLI[@]}" ls > "$TMP/ls.txt")
assert_fixed_contains 'Deep multi-pass security audit of changed files.' "$TMP/ls.txt"
assert_fixed_contains '#security #review' "$TMP/ls.txt"
(cd "$A" && "${CLI[@]}" ls --tag security > "$TMP/ls-tag.txt")
assert_fixed_contains 'skills/security-review' "$TMP/ls-tag.txt"
assert_fixed_contains 'settings/permissions-base' "$TMP/ls-tag.txt"
assert_fixed_not_contains 'skills/hello' "$TMP/ls-tag.txt"
(cd "$A" && "${CLI[@]}" search review > "$TMP/search-tag.txt")
assert_fixed_contains 'skills/security-review' "$TMP/search-tag.txt"
(cd "$A" && "${CLI[@]}" search injection > "$TMP/search-content.txt")
assert_fixed_contains 'skills/security-review' "$TMP/search-content.txt"
assert_fixed_contains 'content(SKILL.md)' "$TMP/search-content.txt"
if ! (cd "$A" && "${CLI[@]}" search no-such-thing-anywhere > "$TMP/search-none.txt"); then
  echo "expected zero-match search to exit 0"
  exit 1
fi
assert_fixed_contains '(no matches)' "$TMP/search-none.txt"

# --- 3. add skill A: requires warning names the fix command on stderr while
#        --json stdout stays parseable; satisfying it silences the warning ---
(cd "$A" && "${CLI[@]}" add skills/security-review --json > "$TMP/add-a.json" 2> "$TMP/add-a-err.txt")
assert_fixed_contains 'missing required items for skills/security-review' "$TMP/add-a-err.txt"
assert_fixed_contains 'capshelf add settings/permissions-base' "$TMP/add-a-err.txt"
assert_fixed_not_contains 'missing required items' "$TMP/add-a.json"
python3 -m json.tool < "$TMP/add-a.json" >/dev/null
assert_fixed_contains '"missingRequires"' "$TMP/add-a.json"
(cd "$A" && "${CLI[@]}" add settings/permissions-base >/dev/null 2>&1)
(cd "$A" && "${CLI[@]}" add skills/security-review > "$TMP/add-a2.txt" 2> "$TMP/add-a2-err.txt")
assert_fixed_not_contains 'missing required items' "$TMP/add-a2-err.txt"

# --- 4. add skill B: refused by the conflicts-with declaration, exit 3 ---
set +e
(cd "$A" && "${CLI[@]}" add skills/quick-review > "$TMP/add-b.txt" 2>&1)
ADD_B_EXIT=$?
set -e
if [ "$ADD_B_EXIT" -ne 3 ]; then
  echo "expected conflicting add to exit 3, got $ADD_B_EXIT"
  exit 1
fi
assert_fixed_contains 'conflicts with installed skills/security-review' "$TMP/add-b.txt"
assert_fixed_contains 'declared by: skills/quick-review/.capshelf.yml' "$TMP/add-b.txt"

# --- 5. a metadata-only data-repo commit is invisible to projects: status
#        stays clean and update leaves the lock byte-identical ---
printf '%s\n' \
  'description: Deep multi-pass security audit of changed files.' \
  'tags: [security, review, audit]' \
  'requires:' \
  '  - settings/permissions-base' \
  > "$DATA/skills/security-review/.capshelf.yml"
git -C "$DATA" add skills/security-review/.capshelf.yml
git -C "$DATA" commit -qm 'tag-only sidecar change'
(cd "$A" && "${CLI[@]}" status --strict >/dev/null)
cp "$A/.capshelf/capshelf.lock.json" "$TMP/lock-before.json"
(cd "$A" && "${CLI[@]}" update >/dev/null)
if ! cmp -s "$TMP/lock-before.json" "$A/.capshelf/capshelf.lock.json"; then
  echo "expected lock to be byte-identical after a metadata-only update"
  exit 1
fi

# --- 6. share carries a project-authored sidecar up (loudly); promote keeps
#        the data-repo sidecar afterwards ---
mkdir -p "$A/.agents/skills/new-local" "$A/.claude/skills"
printf '%s\n' '---' 'name: new-local' '---' '' 'new local skill' > "$A/.agents/skills/new-local/SKILL.md"
printf '%s\n' 'description: Authored in the project.' 'tags: [local]' > "$A/.agents/skills/new-local/.capshelf.yml"
ln -s ../../.agents/skills/new-local "$A/.claude/skills/new-local"
(cd "$A" && "${CLI[@]}" share skills/new-local --to project -m 'initial new-local' > "$TMP/share.txt" 2>&1)
assert_fixed_contains 'project copy contains .capshelf.yml — committed to data repo' "$TMP/share.txt"
assert_fixed_contains 'Authored in the project.' "$DATA/skills/new-local/.capshelf.yml"
printf '%s\n' '---' 'name: new-local' '---' '' 'new local skill v2' > "$A/.agents/skills/new-local/SKILL.md"
(cd "$A" && "${CLI[@]}" promote skills/new-local -m 'new-local v2' >/dev/null)
assert_fixed_contains 'new local skill v2' "$DATA/skills/new-local/SKILL.md"
test -f "$DATA/skills/new-local/.capshelf.yml"
assert_fixed_contains 'Authored in the project.' "$DATA/skills/new-local/.capshelf.yml"

# --- 7. machine outputs stay valid JSON ---
(cd "$A" && "${CLI[@]}" ls --json) | python3 -m json.tool >/dev/null
(cd "$A" && "${CLI[@]}" ls --here --json) | python3 -m json.tool >/dev/null
(cd "$A" && "${CLI[@]}" show skills/security-review --json) | python3 -m json.tool >/dev/null
(cd "$A" && "${CLI[@]}" search security --json) | python3 -m json.tool >/dev/null

echo "✓ smoke-metadata ok ($TMP)"
