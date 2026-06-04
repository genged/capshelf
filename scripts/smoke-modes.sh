#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"

mkdir -p \
  "$HOME" \
  "$DATA/skills/hello" \
  "$DATA/skills/foreign-x" \
  "$DATA/skills/co-owned"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v1' > "$DATA/skills/hello/SKILL.md"
printf '%s\n' '---' 'name: foreign-x' '---' '' 'foreign skill' > "$DATA/skills/foreign-x/SKILL.md"
printf '%s\n' '---' 'name: co-owned' '---' '' 'co-owned skill' > "$DATA/skills/co-owned/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

# --- init: refuses an existing untracked system target ---
CONFLICT="$TMP/conflict-project"
mkdir -p "$CONFLICT/.claude/skills/capshelf"
printf '%s\n' 'local bootstrap' > "$CONFLICT/.claude/skills/capshelf/SKILL.md"
init_git_repo "$CONFLICT"
if (cd "$CONFLICT" && "${CLI[@]}" init --data ../data > "$TMP/init-conflict.txt" 2>&1); then
  echo "expected init to refuse an existing untracked system target"
  exit 1
fi
assert_contains 'target already exists but is not managed' "$TMP/init-conflict.txt"
assert_contains 'local bootstrap' "$CONFLICT/.claude/skills/capshelf/SKILL.md"

# --- codex-compatible mode: .agents materialization + .claude symlinks ---
CODEX="$TMP/codex-project"
mkdir -p "$CODEX/sub"
init_git_repo "$CODEX"
(cd "$CODEX" && "${CLI[@]}" init --data ../data --json > "$TMP/codex-init.json")
test -f "$CODEX/.capshelf/capshelf.json"
test -f "$CODEX/.capshelf/capshelf.lock.json"
test -f "$CODEX/.agents/skills/capshelf/SKILL.md"
test -L "$CODEX/.claude/skills/capshelf"
test ! -f "$CODEX/.claude/capshelf.json"
test ! -f "$CODEX/.agents/capshelf.json"
assert_contains '"installMode": "codex-compatible"' "$CODEX/.capshelf/capshelf.json"
(cd "$CODEX" && "${CLI[@]}" add skills/hello --json >/dev/null)
test -f "$CODEX/.agents/skills/hello/SKILL.md"
test -L "$CODEX/.claude/skills/hello"
test -f "$(cd "$CODEX" && "${CLI[@]}" get-path skills/hello)/SKILL.md"
(cd "$CODEX" && "${CLI[@]}" add skills/co-owned --json >/dev/null)

# --- claude-only mode: direct materialization, no .agents tree ---
CLAUDE="$TMP/claude-project"
mkdir -p "$CLAUDE/sub"
init_git_repo "$CLAUDE"
(cd "$CLAUDE" && "${CLI[@]}" init --claude-only --data ../data --json > "$TMP/claude-init.json")
assert_contains '"installMode": "claude-only"' "$CLAUDE/.capshelf/capshelf.json"
test -f "$CLAUDE/.claude/skills/capshelf/SKILL.md"
test ! -L "$CLAUDE/.claude/skills/capshelf"
test ! -e "$CLAUDE/.agents/skills/capshelf"
(cd "$CLAUDE" && "${CLI[@]}" add skills/hello --json >/dev/null)
test -f "$CLAUDE/.claude/skills/hello/SKILL.md"
test ! -L "$CLAUDE/.claude/skills/hello"
test ! -e "$CLAUDE/.agents/skills/hello"

# --- skills.sh-managed (foreign) interop in codex project ---
# hello and co-owned are real, locally-managed adds; foreign-x is never added.
# Writing a skills-lock.json marks all three as externally managed by skills.sh.
printf '%s\n' '{"version":1,"skills":{"hello":{"source":"acme/hello","sourceType":"github","computedHash":"abc"},"foreign-x":{"source":"acme/foreign-x","sourceType":"github","computedHash":"def"},"co-owned":{"source":"acme/co-owned","sourceType":"github","computedHash":"ghi"}}}' > "$CODEX/skills-lock.json"

# status surfaces the foreign source.
(cd "$CODEX" && "${CLI[@]}" status skills/hello --strict --json > "$TMP/codex-status-hello.json")
assert_contains 'acme/hello' "$TMP/codex-status-hello.json"
(cd "$CODEX" && "${CLI[@]}" status skills/foreign-x --strict --json > "$TMP/codex-status-foreign-x.json")
assert_contains 'acme/foreign-x' "$TMP/codex-status-foreign-x.json"

# rm of a skills.sh-managed compat symlink is rejected; the materialization stays.
if (cd "$CODEX" && "${CLI[@]}" rm skills/hello > "$TMP/codex-rm-hello.txt" 2>&1); then
  echo "expected rm to reject codex skills.sh symlink"
  exit 1
fi
assert_contains 'skills.sh' "$TMP/codex-rm-hello.txt"
test -f "$CODEX/.agents/skills/hello/SKILL.md"
test -L "$CODEX/.claude/skills/hello"

# add of a skills.sh-managed entry is rejected.
if (cd "$CODEX" && "${CLI[@]}" add skills/foreign-x > "$TMP/codex-add-foreign-x.txt" 2>&1); then
  echo "expected add to reject codex skills.sh skill"
  exit 1
fi
assert_contains 'skills.sh' "$TMP/codex-add-foreign-x.txt"

# co-owned: when .claude/skills/<name> is a real dir (skills.sh-owned), status
# still reports it as external and rm refuses to touch the marker.
rm -rf "$CODEX/.claude/skills/co-owned"
(cd "$CODEX" && "${CLI[@]}" status skills/co-owned --strict --json > "$TMP/codex-status-co-owned.json")
assert_contains 'acme/co-owned' "$TMP/codex-status-co-owned.json"
mkdir -p "$CODEX/.claude/skills/co-owned"
printf '%s\n' 'skills.sh-owned marker' > "$CODEX/.claude/skills/co-owned/SKILL.md"
if (cd "$CODEX" && "${CLI[@]}" rm skills/co-owned > "$TMP/codex-rm-co-owned.txt" 2>&1); then
  echo "expected rm to reject co-managed skills.sh skill"
  exit 1
fi
assert_contains 'skills.sh' "$TMP/codex-rm-co-owned.txt"
assert_contains 'skills.sh-owned marker' "$CODEX/.claude/skills/co-owned/SKILL.md"

# apply/update/revert/promote/rm all reject skills.sh-managed entries.
for op in apply update revert promote rm; do
  if (cd "$CODEX" && "${CLI[@]}" $op skills/foreign-x > "$TMP/codex-$op-foreign-x.txt" 2>&1); then
    echo "expected $op to reject skills.sh-managed skill"
    exit 1
  fi
  assert_contains 'skills.sh' "$TMP/codex-$op-foreign-x.txt"
done

# --- personal Claude shadowing ---
SHADOW="$TMP/shadow-project"
mkdir -p "$SHADOW/sub"
init_git_repo "$SHADOW"
(cd "$SHADOW" && "${CLI[@]}" init --data ../data >/dev/null)
mkdir -p "$HOME/.claude/skills/hello"
printf '%s\n' 'personal hello shadows project hello' > "$HOME/.claude/skills/hello/SKILL.md"
(cd "$SHADOW" && "${CLI[@]}" add skills/hello --json > "$TMP/shadow-add.json")
assert_contains '"runtimeWarnings"' "$TMP/shadow-add.json"
assert_contains 'shadowed_by_personal_claude_skill' "$TMP/shadow-add.json"
(cd "$SHADOW" && "${CLI[@]}" status skills/hello --json > "$TMP/shadow-status.json")
assert_contains '"runtimeWarnings"' "$TMP/shadow-status.json"
assert_contains '"personalClaudeExternal"' "$TMP/shadow-status.json"
if (cd "$SHADOW" && "${CLI[@]}" status skills/hello --strict --json > "$TMP/shadow-status-strict.json" 2>&1); then
  echo "expected status --strict to fail on personal Claude skill shadowing"
  exit 1
fi
assert_contains 'shadowed_by_personal_claude_skill' "$TMP/shadow-status-strict.json"
(cd "$SHADOW" && "${CLI[@]}" status skills/hello > "$TMP/shadow-status-human.txt")
assert_contains 'external/  \(Personal Claude\)' "$TMP/shadow-status-human.txt"
HELLO_PATH="$(cd "$SHADOW" && "${CLI[@]}" get-path skills/hello)"
test -f "$HELLO_PATH/SKILL.md"
printf '%s\n' 'local drift' >> "$SHADOW/.claude/skills/hello/SKILL.md"
printf '%s\n' 'stale' > "$SHADOW/.claude/skills/hello/stale.txt"
if (cd "$SHADOW" && "${CLI[@]}" status skills/hello --strict > "$TMP/shadow-drift.txt" 2>&1); then
  echo "expected status --strict to fail on local drift"
  exit 1
fi
(cd "$SHADOW" && "${CLI[@]}" apply skills/hello --dry-run --json > "$TMP/shadow-apply-dry-run.json")
assert_contains '"action": "would-reconcile"' "$TMP/shadow-apply-dry-run.json"
assert_contains 'shadowed_by_personal_claude_skill' "$TMP/shadow-apply-dry-run.json"
assert_contains 'local drift' "$SHADOW/.claude/skills/hello/SKILL.md"
test -f "$SHADOW/.claude/skills/hello/stale.txt"
(cd "$SHADOW" && "${CLI[@]}" apply skills/hello --json > "$TMP/shadow-apply.json")
assert_contains 'shadowed_by_personal_claude_skill' "$TMP/shadow-apply.json"
rm -rf "$HOME/.claude/skills/hello"
assert_contains 'hello v1' "$SHADOW/.claude/skills/hello/SKILL.md"
test ! -e "$SHADOW/.claude/skills/hello/stale.txt"

# --- system item: apply self-heals; promote refuses ---
printf '%s\n' 'broken system skill' > "$SHADOW/.claude/skills/capshelf/SKILL.md"
(cd "$SHADOW" && "${CLI[@]}" apply skills/capshelf --json >/dev/null)
assert_contains '# capshelf' "$SHADOW/.claude/skills/capshelf/SKILL.md"
if (cd "$SHADOW" && "${CLI[@]}" promote skills/capshelf > "$TMP/promote-system.txt" 2>&1); then
  echo "expected promote to reject system items"
  exit 1
fi
assert_contains 'system item' "$TMP/promote-system.txt"

echo "✓ smoke-modes ok ($TMP)"
