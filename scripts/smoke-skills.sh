#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"
B="$TMP/project-b"

mkdir -p "$HOME" "$DATA/skills/hello" "$A/sub" "$B/sub"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v1' > "$DATA/skills/hello/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-skills-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"
init_git_repo "$B"

# --- init (root-only) ---
(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
test -f "$A/.agents/skills/capshelf/SKILL.md"
test -L "$A/.claude/skills/capshelf"
test -f "$A/.capshelf/capshelf.json"
test -f "$A/.capshelf/local.json"
test -f "$A/.capshelf/capshelf.lock.json"
test ! -f "$A/.claude/capshelf.json"
test ! -f "$A/.agents/capshelf.json"
assert_not_contains '"dataRepo": "\.\.' "$A/.capshelf/capshelf.json"
assert_fixed_contains 'local.json' "$A/.capshelf/.gitignore"
(cd "$A" && "${CLI[@]}" ls --json >/dev/null)
mv "$A/.capshelf/local.json" "$TMP/local.json.bak"
if (cd "$A" && "${CLI[@]}" ls > "$TMP/missing-local.txt" 2>&1); then
  echo "expected ls to fail without a data repo binding"
  exit 1
fi
assert_contains 'no data repo configured for this project' "$TMP/missing-local.txt"
mv "$TMP/local.json.bak" "$A/.capshelf/local.json"

# --- add: refuses an existing untracked target ---
mkdir -p "$A/.claude/skills/hello"
printf '%s\n' 'local-only skill' > "$A/.claude/skills/hello/SKILL.md"
if (cd "$A" && "${CLI[@]}" add skills/hello > "$TMP/untracked-add.txt" 2>&1); then
  echo "expected add to refuse an existing untracked target"
  exit 1
fi
assert_contains 'target already exists but is not managed' "$TMP/untracked-add.txt"
rm -rf "$A/.claude/skills/hello"

# --- add: normal flow records the data commit in the lock ---
(cd "$A" && "${CLI[@]}" add skills/hello --json >/dev/null)
test -f "$A/.agents/skills/hello/SKILL.md"
test -L "$A/.claude/skills/hello"
SOURCE_COMMIT="$(git -C "$DATA" log -1 --format=%H -- skills/hello)"
assert_contains "$SOURCE_COMMIT" "$A/.capshelf/capshelf.lock.json"
(cd "$A" && "${CLI[@]}" show skills/hello --json >/dev/null)
(cd "$A" && "${CLI[@]}" status hello --strict --json >/dev/null)

# --- status: upstream dirty (workdir change in data repo) ---
printf '%s\n' '---' 'name: hello' '---' '' 'dirty upstream' > "$DATA/skills/hello/SKILL.md"
(cd "$A" && "${CLI[@]}" status skills/hello --json > "$TMP/upstream-dirty.json")
assert_contains '"state": "upstream_dirty"' "$TMP/upstream-dirty.json"
git -C "$DATA" restore skills/hello/SKILL.md

# --- status: local drift; apply --dry-run reports; apply reconciles, removing stale files ---
printf '%s\n' 'local drift' >> "$A/.claude/skills/hello/SKILL.md"
printf '%s\n' 'stale' > "$A/.claude/skills/hello/stale.txt"
if (cd "$A" && "${CLI[@]}" status skills/hello --strict > "$TMP/drift.txt" 2>&1); then
  echo "expected status --strict to fail on local drift"
  exit 1
fi
assert_contains 'drifted' "$TMP/drift.txt"
(cd "$A" && "${CLI[@]}" apply skills/hello --dry-run --json > "$TMP/apply-dry-run.json")
assert_contains '"action": "would-reconcile"' "$TMP/apply-dry-run.json"
assert_contains 'local drift' "$A/.claude/skills/hello/SKILL.md"
test -f "$A/.claude/skills/hello/stale.txt"
(cd "$A" && "${CLI[@]}" apply skills/hello --json >/dev/null)
assert_contains 'hello v1' "$A/.claude/skills/hello/SKILL.md"
test ! -e "$A/.claude/skills/hello/stale.txt"

# --- keep-local: protects a local fork from apply; revert restores upstream ---
printf '%s\n' 'local fork' > "$A/.claude/skills/hello/SKILL.md"
(cd "$A" && "${CLI[@]}" keep-local skills/hello --reason 'smoke fork' --json >/dev/null)
(cd "$A" && "${CLI[@]}" status skills/hello --strict --json > "$TMP/kept-local.json")
assert_contains '"state": "kept-local"' "$TMP/kept-local.json"
(cd "$A" && "${CLI[@]}" apply skills/hello --json >/dev/null)
assert_contains 'local fork' "$A/.claude/skills/hello/SKILL.md"
(cd "$A" && "${CLI[@]}" keep-local skills/hello --unset --json >/dev/null)
(cd "$A" && "${CLI[@]}" revert skills/hello --json >/dev/null)
assert_contains 'hello v1' "$A/.claude/skills/hello/SKILL.md"

# --- promote: A pushes hello v2 upstream and bumps its own lock ---
printf '%s\n' '---' 'name: hello' '---' '' 'hello v2 promoted' > "$A/.claude/skills/hello/SKILL.md"
(cd "$A" && "${CLI[@]}" promote skills/hello -m 'promote hello v2' --json > "$TMP/promote.json")
assert_contains 'hello v2 promoted' "$DATA/skills/hello/SKILL.md"
PROMOTE_COMMIT="$(git -C "$DATA" log -1 --format=%H -- skills/hello)"
assert_contains "$PROMOTE_COMMIT" "$A/.capshelf/capshelf.lock.json"
(cd "$A" && "${CLI[@]}" status skills/hello --strict --json >/dev/null)

# --- cross-project propagation: B adds (gets v2), then updates to v3 ---
(cd "$B" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$B" && "${CLI[@]}" add skills/hello --json >/dev/null)
assert_contains 'hello v2 promoted' "$B/.claude/skills/hello/SKILL.md"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v3 upstream' > "$DATA/skills/hello/SKILL.md"
git -C "$DATA" add skills/hello/SKILL.md
git -C "$DATA" commit -qm 'hello v3'
(cd "$B" && "${CLI[@]}" status skills/hello --json > "$TMP/update-available.json")
assert_contains '"state": "update_available"' "$TMP/update-available.json"
UPDATE_COMMIT="$(git -C "$DATA" log -1 --format=%H -- skills/hello)"
(cd "$B" && "${CLI[@]}" update skills/hello --dry-run --json > "$TMP/update-dry-run.json")
assert_contains '"action": "would-update"' "$TMP/update-dry-run.json"
assert_contains "$UPDATE_COMMIT" "$TMP/update-dry-run.json"
assert_contains 'hello v2 promoted' "$B/.claude/skills/hello/SKILL.md"
assert_not_contains "$UPDATE_COMMIT" "$B/.capshelf/capshelf.lock.json"
(cd "$B" && "${CLI[@]}" update skills/hello --json >/dev/null)
assert_contains 'hello v3 upstream' "$B/.claude/skills/hello/SKILL.md"
(cd "$B" && "${CLI[@]}" status skills/hello --strict --json >/dev/null)

# --- rm: clears materialization in both trees ---
(cd "$B" && "${CLI[@]}" rm skills/hello --json >/dev/null)
test ! -e "$B/.agents/skills/hello"
test ! -e "$B/.claude/skills/hello"

# --- share: rejects a compatibility symlink that points elsewhere ---
mkdir -p "$A/.agents/skills/bad-alias" "$A/.agents/skills/bad-target" "$A/.claude/skills"
printf '%s\n' '---' 'name: bad-alias' '---' '' 'bad alias skill' > "$A/.agents/skills/bad-alias/SKILL.md"
printf '%s\n' '---' 'name: bad-target' '---' '' 'wrong target' > "$A/.agents/skills/bad-target/SKILL.md"
ln -s ../../.agents/skills/bad-target "$A/.claude/skills/bad-alias"
if (cd "$A" && "${CLI[@]}" share skills/bad-alias --to project -m 'initial bad-alias' > "$TMP/share-bad-alias.txt" 2>&1); then
  echo "expected share to reject bad compatibility alias before data commit"
  exit 1
fi
assert_contains 'compatibility symlink points somewhere else' "$TMP/share-bad-alias.txt"
test ! -e "$DATA/skills/bad-alias"

# --- share: adopt an .agents-resident skill (compat symlink already in .claude) ---
mkdir -p "$A/.agents/skills/new-local"
printf '%s\n' '---' 'name: new-local' '---' '' 'new local skill' > "$A/.agents/skills/new-local/SKILL.md"
ln -s ../../.agents/skills/new-local "$A/.claude/skills/new-local"
(cd "$A" && "${CLI[@]}" share skills/new-local --to project -m 'initial new-local' --json >/dev/null)
test -f "$DATA/skills/new-local/SKILL.md"
assert_contains 'new local skill' "$DATA/skills/new-local/SKILL.md"
(cd "$A" && "${CLI[@]}" status skills/new-local --strict --json >/dev/null)

# --- share: adopt a .claude-only skill, auto-materialize into .agents ---
mkdir -p "$A/.claude/skills/claude-local"
printf '%s\n' '---' 'name: claude-local' '---' '' 'claude local skill' > "$A/.claude/skills/claude-local/SKILL.md"
(cd "$A" && "${CLI[@]}" share skills/claude-local --to project -m 'initial claude-local' --json >/dev/null)
test -f "$DATA/skills/claude-local/SKILL.md"
test -f "$A/.agents/skills/claude-local/SKILL.md"
test -L "$A/.claude/skills/claude-local"
assert_contains 'claude local skill' "$DATA/skills/claude-local/SKILL.md"
(cd "$A" && "${CLI[@]}" status skills/claude-local --strict --json >/dev/null)

# --- rm: refuses a manifest-only untracked target (no lock entry) ---
mkdir -p "$A/.claude/skills/local-only"
printf '%s\n' 'local-only skill' > "$A/.claude/skills/local-only/SKILL.md"
cp "$A/.capshelf/capshelf.json" "$TMP/manifest.bak"
printf '{\n  "installMode": "codex-compatible",\n  "skills": ["local-only"],\n  "settings": [],\n  "mcp": []\n}\n' > "$A/.capshelf/capshelf.json"
printf '{\n  "dataRepo": "%s"\n}\n' "$DATA" > "$A/.capshelf/local.json"
if (cd "$A" && "${CLI[@]}" rm skills/local-only > "$TMP/untracked-rm.txt" 2>&1); then
  echo "expected rm to refuse a manifest-only untracked target"
  exit 1
fi
assert_contains 'no data lock entry exists' "$TMP/untracked-rm.txt"
test -f "$A/.claude/skills/local-only/SKILL.md"
cp "$TMP/manifest.bak" "$A/.capshelf/capshelf.json"

echo "✓ smoke-skills ok ($TMP)"
