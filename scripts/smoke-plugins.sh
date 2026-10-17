#!/usr/bin/env bash
set -euo pipefail

# One non-interactive pass over the plugin lifecycle: install two plugins from
# an upstream repository, report what they run, adopt one onto the shelf,
# give it to the team, install it in a second project, and remove it.
#
# The upstream is a local bare repository. `git clone` from github.com is not
# available in the project container, and the harness rule is that every fetch
# in the suite uses a local bare repository.
#
# `smoke-lib.sh` detaches stdin, so every consent point refuses with exit 3
# unless the call passes `--yes`. The suite checks both.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/xdg"
export XDG_CONFIG_HOME="$TMP/config"
DATA="$TMP/data"
UPSTREAM_WORK="$TMP/upstream-work"
UPSTREAM="$TMP/upstream.git"
P="$TMP/project"
P2="$TMP/project-two"

mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" \
  "$DATA/skills/placeholder" "$P" "$P2"
printf '%s\n' '---' 'name: placeholder' '---' '' 'placeholder' \
  > "$DATA/skills/placeholder/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-plugins-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

# --- the upstream: rust-review runs nothing, gh-cli runs one hook ---
RR="$UPSTREAM_WORK/plugins/rust-review"
GH="$UPSTREAM_WORK/plugins/gh-cli"
mkdir -p "$RR/.claude-plugin" "$RR/skills/rust-review" "$RR/agents" \
  "$GH/.claude-plugin" "$GH/skills/gh-cli" "$GH/hooks"
printf '%s\n' '{"name":"rust-review","version":"1.1.2"}' \
  > "$RR/.claude-plugin/plugin.json"
printf '%s\n' '---' 'name: rust-review' 'description: Review Rust code' '---' \
  '' 'Dispatch rust-review-worker.' > "$RR/skills/rust-review/SKILL.md"
printf '%s\n' 'worker' > "$RR/agents/rust-review-worker.md"
printf '%s\n' '{"name":"gh-cli","version":"1.6.2"}' \
  > "$GH/.claude-plugin/plugin.json"
printf '%s\n' '---' 'name: gh-cli' 'description: Use the gh CLI' '---' '' \
  'body' > "$GH/skills/gh-cli/SKILL.md"
cat > "$GH/hooks/hooks.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash hooks/setup.sh" }] }
    ]
  }
}
JSON
printf '%s\n' 'echo setup' > "$GH/hooks/setup.sh"
init_git_repo "$UPSTREAM_WORK"
configure_git_user "$UPSTREAM_WORK"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "two plugins"
git -C "$UPSTREAM_WORK" branch -M main
git clone -q --bare "$UPSTREAM_WORK" "$UPSTREAM"
URL="file://$(canonical_path "$UPSTREAM")"

init_git_repo "$P"
init_git_repo "$P2"
(cd "$P" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$P2" && "${CLI[@]}" init --data "$DATA" >/dev/null)

# --- add <url> --path <plugin>: a plugin that runs nothing installs whole ---
(cd "$P" && "${CLI[@]}" add "$URL" --path plugins/rust-review --yes \
  > "$TMP/add-rr.txt")
assert_fixed_contains 'added local/remote/plugins/rust-review' "$TMP/add-rr.txt"
assert_fixed_contains 'loads it as rust-review@skills-dir' "$TMP/add-rr.txt"
test -f "$P/.agents/skills/rust-review/.claude-plugin/plugin.json"
test -f "$P/.agents/skills/rust-review/agents/rust-review-worker.md"
test -L "$P/.claude/skills/rust-review"
assert_fixed_contains '"remote/plugins/rust-review"' \
  "$P/.capshelf/remotes.lock.json"

# --- consent point 1: a plugin with a hook refuses with no terminal, names
#     the hook, and writes nothing ---
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-gh.json"
set +e
(cd "$P" && "${CLI[@]}" add "$URL" --path plugins/gh-cli \
  > /dev/null 2> "$TMP/gh-refused.err")
GH_EXIT=$?
set -e
if [ "$GH_EXIT" -ne 3 ]; then
  echo "expected add of a plugin with a hook to exit 3, got $GH_EXIT"
  exit 1
fi
assert_fixed_contains 'not installing plugins/gh-cli without consent' \
  "$TMP/gh-refused.err"
assert_fixed_contains 'SessionStart   bash hooks/setup.sh' "$TMP/gh-refused.err"
cmp -s "$TMP/remotes-before-gh.json" "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/gh-cli"

# --- --yes authorizes it, and prints what it authorized to stderr ---
(cd "$P" && "${CLI[@]}" add "$URL" --path plugins/gh-cli --yes \
  > "$TMP/add-gh.txt" 2> "$TMP/add-gh.err")
assert_fixed_contains 'added local/remote/plugins/gh-cli' "$TMP/add-gh.txt"
assert_fixed_contains 'SessionStart   bash hooks/setup.sh' "$TMP/add-gh.err"
test -f "$P/.agents/skills/gh-cli/hooks/hooks.json"

# --- status: the hook count, as text and as JSON ---
(cd "$P" && "${CLI[@]}" status > "$TMP/status.txt")
assert_contains 'plugins/gh-cli .* hooks: 1$' "$TMP/status.txt"
assert_not_contains 'plugins/rust-review .* hooks:' "$TMP/status.txt"
(cd "$P" && "${CLI[@]}" status --json > "$TMP/status.json")
assert_fixed_contains '"hooks": 1' "$TMP/status.json"
assert_fixed_contains '"claudeTrust": "unknown"' "$TMP/status.json"
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

# --- share --adopt: the plugin moves onto the shelf, in local scope ---
(cd "$P" && "${CLI[@]}" share plugins/rust-review --adopt -m a --yes \
  > "$TMP/adopt.txt" 2> "$TMP/adopt.err")
assert_fixed_contains 'adopted local/data/plugins/rust-review' "$TMP/adopt.txt"
assert_fixed_contains 'released: remote row for plugins/rust-review' \
  "$TMP/adopt.txt"
test -f "$DATA/plugins/rust-review/.claude-plugin/plugin.json"
assert_fixed_contains 'upstreamPath: plugins/rust-review' \
  "$DATA/plugins/rust-review/.capshelf.yml"
test ! -e "$P/.agents/skills/rust-review/.capshelf.yml"
assert_fixed_not_contains '"remote/plugins/rust-review"' \
  "$P/.capshelf/remotes.lock.json"
assert_fixed_contains '"rust-review"' "$P/.capshelf/local.json"
assert_fixed_contains '"shelves"' "$P/.capshelf/local.json"
test -z "$(git -C "$DATA" status --porcelain)"

# --- move --to project: the manifest takes the plugin and the fence ---
(cd "$P" && "${CLI[@]}" move plugins/rust-review --to project --yes \
  > "$TMP/move.txt")
assert_fixed_contains 'moved data/plugins/rust-review from local to project' \
  "$TMP/move.txt"
assert_fixed_contains '"rust-review"' "$P/.capshelf/capshelf.json"
assert_fixed_contains '"shelves"' "$P/.capshelf/capshelf.json"
assert_fixed_not_contains '"shelves"' "$P/.capshelf/local.json"
assert_fixed_contains '"data/plugins/rust-review"' \
  "$P/.capshelf/capshelf.lock.json"

# --- a second project adds it from the shelf ---
(cd "$P2" && "${CLI[@]}" add plugins/rust-review > "$TMP/add-p2.txt")
assert_fixed_contains 'added project/data/plugins/rust-review' \
  "$TMP/add-p2.txt"
test -f "$P2/.agents/skills/rust-review/agents/rust-review-worker.md"
test ! -e "$P2/.agents/skills/rust-review/.capshelf.yml"
(cd "$P2" && "${CLI[@]}" status --strict --json >/dev/null)

# Run a command in project "$1" that must refuse with exit 3 and no terminal.
# Its stderr goes to "$2".
expect_consent_refusal() {
  local project="$1" err="$2" code
  shift 2
  set +e
  (cd "$project" && "${CLI[@]}" "$@" > /dev/null 2> "$err")
  code=$?
  set -e
  if [ "$code" -ne 3 ]; then
    echo "expected '$*' to exit 3 without consent, got $code"
    cat "$err"
    exit 1
  fi
}

# --- consent point 2: the upstream adds a hook to gh-cli. The pin move
#     refuses with no terminal and names the new hook ---
cat > "$GH/hooks/hooks.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash hooks/setup.sh" }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "bash hooks/format.sh" }] }
    ]
  }
}
JSON
printf '%s\n' 'echo format' > "$GH/hooks/format.sh"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "gh-cli: add a hook"
git -C "$UPSTREAM_WORK" push -q "$UPSTREAM" main
(cd "$P" && "${CLI[@]}" status --check-upstream --json > "$TMP/checked.json")
assert_fixed_contains '"state": "update_available"' "$TMP/checked.json"

(cd "$P" && "${CLI[@]}" update plugins/gh-cli --dry-run --json \
  > "$TMP/update-dry.json")
assert_fixed_contains '"newRuns"' "$TMP/update-dry.json"
assert_fixed_contains 'bash hooks/format.sh' "$TMP/update-dry.json"

cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-update.json"
expect_consent_refusal "$P" "$TMP/update-refused.err" update plugins/gh-cli
assert_fixed_contains 'PostToolUse   bash hooks/format.sh' \
  "$TMP/update-refused.err"
cmp -s "$TMP/remotes-before-update.json" "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/gh-cli/hooks/format.sh"

(cd "$P" && "${CLI[@]}" update plugins/gh-cli --yes > /dev/null \
  2> "$TMP/update.err")
assert_fixed_contains 'PostToolUse   bash hooks/format.sh' "$TMP/update.err"
test -f "$P/.agents/skills/gh-cli/hooks/format.sh"

# --- consent point 3: an adopt into project scope commits the hooks for
#     every teammate. It refuses with no terminal, before the data repo
#     changes ---
DATA_HEAD="$(git -C "$DATA" rev-parse HEAD)"
expect_consent_refusal "$P" "$TMP/adopt-gh-refused.err" \
  share plugins/gh-cli --adopt --to project -m gh
assert_fixed_contains "every teammate's" "$TMP/adopt-gh-refused.err"
test "$(git -C "$DATA" rev-parse HEAD)" = "$DATA_HEAD"
test ! -e "$DATA/plugins/gh-cli"

(cd "$P" && "${CLI[@]}" share plugins/gh-cli --adopt --to project -m gh \
  --yes > "$TMP/adopt-gh.txt" 2>/dev/null)
assert_fixed_contains 'adopted project/data/plugins/gh-cli' "$TMP/adopt-gh.txt"
assert_fixed_contains '"data/plugins/gh-cli"' "$P/.capshelf/capshelf.lock.json"

# --- a shelf add of a plugin with hooks asks too ---
expect_consent_refusal "$P2" "$TMP/add-gh-p2.err" add plugins/gh-cli
assert_fixed_contains 'not installing plugins/gh-cli without consent' \
  "$TMP/add-gh-p2.err"
test ! -e "$P2/.agents/skills/gh-cli"
(cd "$P2" && "${CLI[@]}" add plugins/gh-cli --yes > /dev/null 2>&1)
test -f "$P2/.agents/skills/gh-cli/hooks/format.sh"

for project in "$P" "$P2"; do
  (cd "$project" && "${CLI[@]}" rm plugins/gh-cli --yes > /dev/null)
  test ! -e "$project/.agents/skills/gh-cli"
done

# --- rm in both projects: the files, the lock rows, and the fence go ---
for project in "$P" "$P2"; do
  (cd "$project" && "${CLI[@]}" rm plugins/rust-review --yes > "$TMP/rm.txt")
  assert_fixed_contains 'removed data/plugins/rust-review' "$TMP/rm.txt"
  test ! -e "$project/.agents/skills/rust-review"
  test ! -e "$project/.claude/skills/rust-review"
  assert_fixed_not_contains '"shelves"' "$project/.capshelf/capshelf.json"
  assert_fixed_not_contains 'data/plugins/rust-review' \
    "$project/.capshelf/capshelf.lock.json"
done

# --- the shelf copy stays: rm never edits the data repo ---
test -f "$DATA/plugins/rust-review/.claude-plugin/plugin.json"

(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)
(cd "$P2" && "${CLI[@]}" status --strict --json >/dev/null)

rm -rf "$TMP"
echo "✓ smoke-plugins"
