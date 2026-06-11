#!/usr/bin/env bash
# Two-clone team loop against a local bare remote: sync-data outcome states,
# stale-promote protection, convergence repin, and missing_source_commit.
# No network: every remote is a local bare repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
A_DATA="$TMP/data-a"
B_DATA="$TMP/data-b"
C_DATA="$TMP/data-c"
PA="$TMP/project-a"
PB="$TMP/project-b"
PC="$TMP/project-c"
mkdir -p "$HOME"

run_expect_exit() {
  local expected="$1"
  local out="$2"
  shift 2
  local code=0
  "$@" > "$out" 2>&1 || code=$?
  if [ "$code" -ne "$expected" ]; then
    echo "expected exit $expected, got $code: $*"
    cat "$out"
    exit 1
  fi
}

assert_valid_json() {
  bun -e 'const fs = require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));' "$1"
}

# --- 1. bare origin, seeded; two clones; two bound projects -----------------
git init -q --initial-branch=main --bare "$ORIGIN"
git clone -q "$ORIGIN" "$SEED" 2>/dev/null
configure_git_user "$SEED"
mkdir -p "$SEED/skills/hello"
printf '%s\n' '---' 'name: hello' '---' '' 'hello v1' > "$SEED/skills/hello/SKILL.md"
git -C "$SEED" add -A
git -C "$SEED" commit -qm baseline
git -C "$SEED" push -q origin main

git clone -q "$ORIGIN" "$A_DATA"
git clone -q "$ORIGIN" "$B_DATA"
configure_git_user "$A_DATA"
configure_git_user "$B_DATA"
# Any branch name asserted on is read back from the repo, never hard-coded.
BRANCH="$(git -C "$B_DATA" symbolic-ref --short HEAD)"

mkdir -p "$PA" "$PB"
git -C "$PA" init -q -b main
git -C "$PB" init -q -b main
(cd "$PA" && "${CLI[@]}" init --data "$A_DATA" --no-upstream >/dev/null)
(cd "$PB" && "${CLI[@]}" init --data "$B_DATA" --no-upstream >/dev/null)
(cd "$PA" && "${CLI[@]}" add skills/hello >/dev/null)
(cd "$PB" && "${CLI[@]}" add skills/hello >/dev/null)

# --- 2. team loop: promote+push in PA; sync-data + update in PB -------------
printf 'hello v2 from alice\n' >> "$PA/.agents/skills/hello/SKILL.md"
(cd "$PA" && "${CLI[@]}" promote skills/hello -m 'alice v2' >/dev/null)
git -C "$A_DATA" push -q
B_BEFORE="$(git -C "$B_DATA" rev-parse HEAD)"
(cd "$PB" && "${CLI[@]}" sync-data --json > "$TMP/sync-ff.json")
assert_valid_json "$TMP/sync-ff.json"
assert_fixed_contains '"state": "fast_forwarded"' "$TMP/sync-ff.json"
assert_fixed_contains "\"branch\": \"$BRANCH\"" "$TMP/sync-ff.json"
test "$(git -C "$B_DATA" rev-parse HEAD)" = "$(git -C "$A_DATA" rev-parse HEAD)"
test "$(git -C "$B_DATA" rev-parse HEAD)" != "$B_BEFORE"
(cd "$PB" && "${CLI[@]}" status --json > "$TMP/status-update.json")
assert_fixed_contains '"state": "update_available"' "$TMP/status-update.json"
(cd "$PB" && "${CLI[@]}" update skills/hello >/dev/null)
(cd "$PB" && "${CLI[@]}" status --strict >/dev/null)
assert_fixed_contains 'hello v2 from alice' "$PB/.agents/skills/hello/SKILL.md"

# --- 3. second run is a no-op ------------------------------------------------
(cd "$PB" && "${CLI[@]}" sync-data --json > "$TMP/sync-noop.json")
assert_fixed_contains '"state": "up_to_date"' "$TMP/sync-noop.json"

# --- 4. local_ahead: unpushed promote is exit 0 with push guidance ----------
printf 'hello v3 from bob\n' >> "$PB/.agents/skills/hello/SKILL.md"
(cd "$PB" && "${CLI[@]}" promote skills/hello -m 'bob v3' >/dev/null)
B_AHEAD_HEAD="$(git -C "$B_DATA" rev-parse HEAD)"
(cd "$PB" && "${CLI[@]}" sync-data > "$TMP/sync-ahead.txt")
assert_fixed_contains "ahead of origin/$BRANCH by 1 commit" "$TMP/sync-ahead.txt"
assert_fixed_contains 'to share your promoted commits:' "$TMP/sync-ahead.txt"
assert_fixed_contains 'push' "$TMP/sync-ahead.txt"
test "$(git -C "$B_DATA" rev-parse HEAD)" = "$B_AHEAD_HEAD"
git -C "$B_DATA" push -q
# PA picks up bob's change before promoting again.
(cd "$PA" && "${CLI[@]}" sync-data >/dev/null)
(cd "$PA" && "${CLI[@]}" update skills/hello >/dev/null)

# --- 5 + 11. diverged: exit 4, JSON printed first, nothing lost -------------
printf 'b-local notes\n' > "$B_DATA/notes.txt"
git -C "$B_DATA" add notes.txt
git -C "$B_DATA" commit -qm 'b local commit'
printf 'hello v4 from alice\n' >> "$PA/.agents/skills/hello/SKILL.md"
(cd "$PA" && "${CLI[@]}" promote skills/hello -m 'alice v4' >/dev/null)
git -C "$A_DATA" push -q
B_DIVERGED_HEAD="$(git -C "$B_DATA" rev-parse HEAD)"
run_expect_exit 4 "$TMP/sync-diverged.json" \
  env -C "$PB" "${CLI[@]}" sync-data --json
assert_valid_json "$TMP/sync-diverged.json"
assert_fixed_contains '"state": "diverged"' "$TMP/sync-diverged.json"
run_expect_exit 4 "$TMP/sync-diverged.txt" \
  env -C "$PB" "${CLI[@]}" sync-data
assert_fixed_contains 'have diverged' "$TMP/sync-diverged.txt"
# Local commit and worktree intact; remote-tracking ref updated by the fetch.
test "$(git -C "$B_DATA" rev-parse HEAD)" = "$B_DIVERGED_HEAD"
assert_fixed_contains 'b-local notes' "$B_DATA/notes.txt"
test "$(git -C "$B_DATA" rev-parse "origin/$BRANCH")" = "$(git -C "$ORIGIN" rev-parse "$BRANCH")"
# Reconcile with ordinary git, as the guidance says.
git -C "$B_DATA" rebase -q "origin/$BRANCH"
git -C "$B_DATA" push -q
(cd "$PB" && "${CLI[@]}" update skills/hello >/dev/null)
(cd "$PA" && "${CLI[@]}" sync-data >/dev/null)

# --- 6. dirty worktree: blocks only an otherwise-possible fast-forward ------
printf 'dirty edit\n' >> "$B_DATA/notes.txt"
(cd "$PB" && "${CLI[@]}" sync-data --json > "$TMP/sync-dirty-noop.json")
assert_fixed_contains '"state": "up_to_date"' "$TMP/sync-dirty-noop.json"
assert_fixed_contains '"dirty": true' "$TMP/sync-dirty-noop.json"
printf 'hello v5 from alice\n' >> "$PA/.agents/skills/hello/SKILL.md"
(cd "$PA" && "${CLI[@]}" promote skills/hello -m 'alice v5' >/dev/null)
git -C "$A_DATA" push -q
run_expect_exit 4 "$TMP/sync-dirty.txt" \
  env -C "$PB" "${CLI[@]}" sync-data
assert_fixed_contains 'uncommitted changes; not fast-forwarding over them' "$TMP/sync-dirty.txt"
# Worktree byte-identical afterwards.
assert_fixed_contains 'dirty edit' "$B_DATA/notes.txt"
git -C "$B_DATA" checkout -q -- notes.txt
(cd "$PB" && "${CLI[@]}" sync-data --json > "$TMP/sync-after-clean.json")
assert_fixed_contains '"state": "fast_forwarded"' "$TMP/sync-after-clean.json"
(cd "$PB" && "${CLI[@]}" update skills/hello >/dev/null)

# --- 7. detached HEAD, no tracking ref, no origin, fetch failure ------------
git -C "$B_DATA" checkout -q --detach
run_expect_exit 3 "$TMP/sync-detached.txt" \
  env -C "$PB" "${CLI[@]}" sync-data
assert_fixed_contains 'detached HEAD; capshelf will not move it' "$TMP/sync-detached.txt"
git -C "$B_DATA" switch -q "$BRANCH"

git -C "$B_DATA" switch -q -c propose/foo
run_expect_exit 3 "$TMP/sync-no-tracking.txt" \
  env -C "$PB" "${CLI[@]}" sync-data
assert_fixed_contains 'no upstream tracking ref' "$TMP/sync-no-tracking.txt"
assert_fixed_contains 'push -u origin propose/foo' "$TMP/sync-no-tracking.txt"
git -C "$B_DATA" switch -q "$BRANCH"
git -C "$B_DATA" branch -q -D propose/foo

git clone -q "$ORIGIN" "$C_DATA"
configure_git_user "$C_DATA"
git -C "$C_DATA" remote remove origin
mkdir -p "$PC"
git -C "$PC" init -q -b main
(cd "$PC" && "${CLI[@]}" init --data "$C_DATA" --no-upstream >/dev/null)
run_expect_exit 3 "$TMP/sync-no-origin.txt" \
  env -C "$PC" "${CLI[@]}" sync-data
assert_fixed_contains 'no `origin` remote to sync from' "$TMP/sync-no-origin.txt"

git -C "$B_DATA" remote set-url origin "$TMP/does-not-exist.git"
run_expect_exit 1 "$TMP/sync-fetch-failed.txt" \
  env -C "$PB" "${CLI[@]}" sync-data
assert_fixed_contains 'failed to fetch origin' "$TMP/sync-fetch-failed.txt"
git -C "$B_DATA" remote set-url origin "$ORIGIN"

# --- 8. stale promote: blocked, then bypassed with --stale-ok ---------------
printf 'hello v6 from alice\n' >> "$PA/.agents/skills/hello/SKILL.md"
(cd "$PA" && "${CLI[@]}" promote skills/hello -m 'alice v6' >/dev/null)
git -C "$A_DATA" push -q
# Bob syncs the clone but does NOT update the project lock, then edits.
(cd "$PB" && "${CLI[@]}" sync-data >/dev/null)
printf 'hello v6 from bob, conflicting\n' >> "$PB/.agents/skills/hello/SKILL.md"
B_STALE_HEAD="$(git -C "$B_DATA" rev-parse HEAD)"
run_expect_exit 3 "$TMP/promote-stale.txt" \
  env -C "$PB" "${CLI[@]}" promote skills/hello -m 'bob stale'
assert_fixed_contains 'changed in the data repo since this project last updated' "$TMP/promote-stale.txt"
assert_fixed_contains '--stale-ok' "$TMP/promote-stale.txt"
# No commit was created and the upstream content is untouched.
test "$(git -C "$B_DATA" rev-parse HEAD)" = "$B_STALE_HEAD"
assert_fixed_contains 'hello v6 from alice' "$B_DATA/skills/hello/SKILL.md"
(cd "$PB" && "${CLI[@]}" promote skills/hello --stale-ok -m 'bob overwrite' --json > "$TMP/promote-stale-ok.json")
assert_valid_json "$TMP/promote-stale-ok.json"
assert_fixed_contains '"staleOverride": true' "$TMP/promote-stale-ok.json"
test "$(git -C "$B_DATA" rev-parse HEAD)" != "$B_STALE_HEAD"
assert_contains "$(git -C "$B_DATA" rev-parse HEAD)" "$PB/.capshelf/capshelf.lock.json"
git -C "$B_DATA" push -q
(cd "$PA" && "${CLI[@]}" sync-data >/dev/null)
(cd "$PA" && "${CLI[@]}" update skills/hello >/dev/null)

# --- 9. convergence: byte-identical edit re-pins without a commit -----------
printf 'hello v7 from alice\n' >> "$PA/.agents/skills/hello/SKILL.md"
(cd "$PA" && "${CLI[@]}" promote skills/hello -m 'alice v7' >/dev/null)
git -C "$A_DATA" push -q
(cd "$PB" && "${CLI[@]}" sync-data >/dev/null)
# Bob lands on the same bytes alice already pushed, without updating first.
cp "$B_DATA/skills/hello/SKILL.md" "$PB/.agents/skills/hello/SKILL.md"
ALICE_COMMIT="$(git -C "$B_DATA" rev-parse HEAD)"
(cd "$PB" && "${CLI[@]}" promote skills/hello -m 'bob same fix' --json > "$TMP/promote-converge.json")
assert_fixed_contains '"action": "already-upstream"' "$TMP/promote-converge.json"
test "$(git -C "$B_DATA" rev-parse HEAD)" = "$ALICE_COMMIT"
assert_contains "$ALICE_COMMIT" "$PB/.capshelf/capshelf.lock.json"
(cd "$PB" && "${CLI[@]}" status --strict >/dev/null)

# --- 10. upstream-dirty item path blocks even with --stale-ok ---------------
printf 'hello v8 from bob\n' >> "$PB/.agents/skills/hello/SKILL.md"
printf 'uncommitted upstream tinkering\n' >> "$B_DATA/skills/hello/SKILL.md"
run_expect_exit 3 "$TMP/promote-upstream-dirty.txt" \
  env -C "$PB" "${CLI[@]}" promote skills/hello -m 'bob v8'
assert_fixed_contains 'uncommitted changes' "$TMP/promote-upstream-dirty.txt"
run_expect_exit 3 "$TMP/promote-upstream-dirty-ok.txt" \
  env -C "$PB" "${CLI[@]}" promote skills/hello --stale-ok -m 'bob v8'
assert_fixed_contains 'uncommitted changes' "$TMP/promote-upstream-dirty-ok.txt"
# The uncommitted data-repo edit survives.
assert_fixed_contains 'uncommitted upstream tinkering' "$B_DATA/skills/hello/SKILL.md"
git -C "$B_DATA" checkout -q -- skills/hello

# --- 12. orphaned sourceCommit: missing_source_commit + strict gate ---------
(cd "$PB" && "${CLI[@]}" promote skills/hello -m 'bob v8 unpushed' >/dev/null)
UNPUSHED_COMMIT="$(git -C "$B_DATA" rev-parse HEAD)"
assert_contains "$UNPUSHED_COMMIT" "$PB/.capshelf/capshelf.lock.json"
git clone -q "$ORIGIN" "$TMP/fresh-1"
(cd "$PB" && "${CLI[@]}" --data "$TMP/fresh-1" status --json > "$TMP/status-orphan.json")
assert_fixed_contains '"state": "missing_source_commit"' "$TMP/status-orphan.json"
(cd "$PB" && "${CLI[@]}" --data "$TMP/fresh-1" status > "$TMP/status-orphan.txt")
assert_fixed_contains 'not present in the data repo' "$TMP/status-orphan.txt"
assert_fixed_contains 'capshelf sync-data && capshelf update skills/hello' "$TMP/status-orphan.txt"
run_expect_exit 4 "$TMP/status-orphan-strict.txt" \
  env -C "$PB" "${CLI[@]}" --data "$TMP/fresh-1" status --strict
# Push the clone that has the commit, re-clone, re-pin, and the gate goes green.
git -C "$B_DATA" push -q
git clone -q "$ORIGIN" "$TMP/fresh-2"
configure_git_user "$TMP/fresh-2"
(cd "$PB" && "${CLI[@]}" --data "$TMP/fresh-2" update skills/hello >/dev/null)
(cd "$PB" && "${CLI[@]}" --data "$TMP/fresh-2" status --strict >/dev/null)

echo "✓ smoke-team-sync ok ($TMP)"
