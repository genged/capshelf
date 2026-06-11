#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

mkdir -p "$HOME" "$DATA/settings/security" "$A/sub"
printf '%s\n' '{"permissions":{"deny":["Read(./.env)","Bash(curl *)"]}}' > "$DATA/settings/security/settings.json"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-settings-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"

(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
mkdir -p "$A/.claude"
printf '%s\n' '{"permissions":{"allow":["Bash(git status *)"]},"env":{"PROJECT_MODE":"dev"}}' > "$A/.claude/settings.json"

# --- add: merges fragment into existing project settings ---
(cd "$A" && "${CLI[@]}" add settings/security --json > "$TMP/settings-add.json")
assert_fixed_contains 'Bash(git status *)' "$A/.claude/settings.json"
assert_fixed_contains 'Bash(curl *)' "$A/.claude/settings.json"
assert_fixed_contains 'PROJECT_MODE' "$A/.claude/settings.json"
(cd "$A" && "${CLI[@]}" status settings/security --strict --json >/dev/null)

# --- status: three-way diff against drifted project settings ---
printf '%s\n' '{"permissions":{"allow":["Bash(git status *)"],"deny":["Read(./.env)"]},"env":{"PROJECT_MODE":"dev"}}' > "$A/.claude/settings.json"
(cd "$A" && "${CLI[@]}" status settings/security --diff > "$TMP/settings-drift-diff.txt")
assert_contains 'diff data/settings/security' "$TMP/settings-drift-diff.txt"
assert_fixed_contains 'Bash(curl *)' "$TMP/settings-drift-diff.txt"

# --- apply: re-merges fragment into project settings ---
(cd "$A" && "${CLI[@]}" apply settings/security --json >/dev/null)

# --- update flow: upstream changes the fragment; three-way merge picks up new local + new upstream ---
printf '%s\n' '{"permissions":{"deny":["Read(./.env)","Bash(wget *)"]}}' > "$DATA/settings/security/settings.json"
git -C "$DATA" add settings/security/settings.json
git -C "$DATA" commit -qm 'security settings v2'
SETTINGS_COMMIT="$(git -C "$DATA" log -1 --format=%H -- settings/security)"
(cd "$A" && "${CLI[@]}" status settings/security --json > "$TMP/settings-update-available.json")
assert_contains '"state": "update_available"' "$TMP/settings-update-available.json"
printf '%s\n' '{"permissions":{"allow":["Bash(git status *)"],"deny":["Read(./tmp/private/**)","Read(./.env)","Bash(curl *)"]},"env":{"PROJECT_MODE":"dev"}}' > "$A/.claude/settings.json"
(cd "$A" && "${CLI[@]}" update settings/security --dry-run --json > "$TMP/settings-dry-run.json")
assert_contains '"action": "would-update"' "$TMP/settings-dry-run.json"
assert_contains "$SETTINGS_COMMIT" "$TMP/settings-dry-run.json"
assert_fixed_contains 'Bash(curl *)' "$A/.claude/settings.json"
assert_not_contains "$SETTINGS_COMMIT" "$A/.capshelf/capshelf.lock.json"
(cd "$A" && "${CLI[@]}" update settings/security --json >/dev/null)
assert_fixed_contains 'Read(./tmp/private/**)' "$A/.claude/settings.json"
assert_fixed_contains 'Bash(wget *)' "$A/.claude/settings.json"
assert_fixed_not_contains 'Bash(curl *)' "$A/.claude/settings.json"
(cd "$A" && "${CLI[@]}" status settings/security --strict --json >/dev/null)

# --- get-path/promote: settings source edits commit canonical fragment files ---
SETTINGS_PATH="$(cd "$A" && "${CLI[@]}" get-path settings/security)"
if [[ "$(canonical_path "$SETTINGS_PATH")" != "$(canonical_path "$DATA/settings/security/settings.json")" ]]; then
  echo "unexpected settings get-path: $SETTINGS_PATH"
  exit 1
fi
OUTPUT_PATH="$(cd "$A" && "${CLI[@]}" get-path settings/security --output)"
if [[ "$(canonical_path "$OUTPUT_PATH")" != "$(canonical_path "$A/.claude/settings.json")" ]]; then
  echo "unexpected settings output path: $OUTPUT_PATH"
  exit 1
fi
printf '%s\n' '{"permissions":{"deny":["Read(./.env)","Bash(fetch *)"]}}' > "$DATA/settings/security/settings.json"
(cd "$A" && "${CLI[@]}" promote settings/security -m 'tighten settings' --json > "$TMP/settings-promote.json")
assert_contains '"action": "promoted"' "$TMP/settings-promote.json"
assert_fixed_contains 'Bash(fetch *)' "$A/.claude/settings.json"
assert_fixed_not_contains 'Bash(wget *)' "$A/.claude/settings.json"
assert_fixed_contains 'tighten settings' <(git -C "$DATA" log -1 --format=%s)

echo "✓ smoke-settings ok ($TMP)"
