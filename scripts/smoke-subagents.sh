#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"
B="$TMP/project-b"
AGENT="$DATA/subagents/reviewer"

mkdir -p "$HOME" "$AGENT" "$A" "$B"
printf '%s\n' \
  '---' \
  'name: reviewer' \
  'description: Review changes carefully.' \
  '---' \
  '' \
  'Review the change for correctness and security.' \
  > "$AGENT/claude.md"
printf '%s\n' \
  'name = "reviewer"' \
  'description = "Review changes carefully."' \
  'developer_instructions = "Review the change for correctness and security."' \
  > "$AGENT/codex.toml"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-subagents-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"
init_git_repo "$B"

(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$B" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$A" && "${CLI[@]}" add subagents/reviewer --json > "$TMP/add-a.json")
(cd "$B" && "${CLI[@]}" add subagents/reviewer --json > "$TMP/add-b.json")
test -f "$A/.claude/agents/reviewer.md"
test -f "$A/.codex/agents/reviewer.toml"
assert_contains '"data/subagents/reviewer"' "$A/.capshelf/capshelf.lock.json"
assert_contains '"subagents": \[' "$A/.capshelf/capshelf.json"

printf '%s\n' \
  '---' \
  'name: reviewer' \
  'description: Review changes carefully.' \
  '---' \
  '' \
  'Review the change for correctness, security, and reliability.' \
  > "$A/.claude/agents/reviewer.md"
(cd "$A" && "${CLI[@]}" status subagents/reviewer --json > "$TMP/status-drift.json")
assert_contains '"state": "drifted_local"' "$TMP/status-drift.json"
(cd "$A" && "${CLI[@]}" promote subagents/reviewer -m 'update reviewer' --json > "$TMP/promote.json")
assert_contains '"action": "promoted"' "$TMP/promote.json"
assert_contains "reliability" "$AGENT/claude.md"
(cd "$A" && "${CLI[@]}" status subagents/reviewer --strict --json >/dev/null)

# Project B remains pinned until its own explicit update.
assert_contains "correctness and security" "$B/.claude/agents/reviewer.md"
(cd "$B" && "${CLI[@]}" status subagents/reviewer --json > "$TMP/status-update.json")
assert_contains '"state": "update_available"' "$TMP/status-update.json"
(cd "$B" && "${CLI[@]}" update subagents/reviewer --json >/dev/null)
assert_contains "reliability" "$B/.claude/agents/reviewer.md"

# Removing an upstream target removes only the formerly managed runtime file.
rm "$AGENT/codex.toml"
git -C "$DATA" add -A
git -C "$DATA" commit -qm 'make reviewer Claude only'
(cd "$B" && "${CLI[@]}" update subagents/reviewer >/dev/null)
test ! -e "$B/.codex/agents/reviewer.toml"
test -f "$B/.claude/agents/reviewer.md"

echo "✓ smoke-subagents ok ($TMP)"
