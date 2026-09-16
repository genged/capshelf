#!/usr/bin/env bash
set -euo pipefail

# One non-interactive pass over the pulled-skill workflow: install from a
# repository URL, list, report offline, check the upstream, move the pin, and
# transfer ownership into the shelf.
#
# The upstream is a local bare repository. `git clone` from github.com is not
# available in the project container, and the harness rule is that every fetch
# in the suite uses a local bare repository.
#
# `smoke-lib.sh` detaches stdin; it does not pass `--yes`. Every destructive or
# consent-gated call below passes its own, or it refuses with exit 3.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/xdg"
DATA="$TMP/data"
UPSTREAM_WORK="$TMP/upstream-work"
UPSTREAM="$TMP/upstream.git"
P="$TMP/project"

mkdir -p "$HOME" "$XDG_DATA_HOME" "$DATA/skills/placeholder" "$P"
printf '%s\n' '---' 'name: placeholder' '---' '' 'placeholder' \
  > "$DATA/skills/placeholder/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-remote-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

# --- the upstream: a bare repository holding two skills on `main` ---
mkdir -p "$UPSTREAM_WORK/skills/pdf" "$UPSTREAM_WORK/skills/xlsx"
printf '%s\n' '---' 'name: pdf' 'description: Extract text' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/pdf/SKILL.md"
printf '%s\n' '---' 'name: xlsx' 'description: Read workbooks' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/xlsx/SKILL.md"
init_git_repo "$UPSTREAM_WORK"
configure_git_user "$UPSTREAM_WORK"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "two skills"
git -C "$UPSTREAM_WORK" branch -M main
git clone -q --bare "$UPSTREAM_WORK" "$UPSTREAM"
git -C "$UPSTREAM_WORK" remote add origin "$UPSTREAM"
UPSTREAM_URL="file://$(canonical_path "$UPSTREAM")"

init_git_repo "$P"
(cd "$P" && "${CLI[@]}" init --data "$DATA" >/dev/null)

# --- add --list: reports the repository and writes nothing ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --list --json > "$TMP/list.json")
assert_fixed_contains '"skills/pdf"' "$TMP/list.json"
assert_fixed_contains '"skills/xlsx"' "$TMP/list.json"
test ! -e "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/pdf"

# --- two candidates without a terminal refuse and name the two flags ---
if (cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --yes --json > "$TMP/ambiguous.json" 2>&1); then
  echo "expected add to refuse an ambiguous repository"
  exit 1
fi
assert_fixed_contains '--path' "$TMP/ambiguous.json"

# --- add <url> --path: installs one skill, records it, commits nothing ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add.json")
assert_fixed_contains '"source": "remote"' "$TMP/add.json"
assert_fixed_contains '"action": "created"' "$TMP/add.json"
test -f "$P/.agents/skills/pdf/SKILL.md"
assert_fixed_contains 'remotes.lock.json' "$P/.capshelf/.gitignore"
test -z "$(git -C "$P" ls-files .capshelf/remotes.lock.json)"
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

# --- a second add of the same URL is a byte-stable no-op ---
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before.json"
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add-again.json")
assert_fixed_contains '"action": "already-current"' "$TMP/add-again.json"
cmp -s "$TMP/remotes-before.json" "$P/.capshelf/remotes.lock.json"

# --- status: the remote group, offline, never checked ---
(cd "$P" && "${CLI[@]}" status > "$TMP/status.txt")
assert_fixed_contains 'remote/  (skills pinned to repos outside your shelf)' "$TMP/status.txt"
assert_fixed_contains 'never checked' "$TMP/status.txt"
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

# --- the upstream moves; only --check-upstream sees it ---
printf '%s\n' '---' 'name: pdf' 'description: Extract text and tables' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/pdf/SKILL.md"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "revise pdf"
git -C "$UPSTREAM_WORK" push -q origin main

(cd "$P" && "${CLI[@]}" status --json > "$TMP/status-offline.json")
assert_fixed_contains '"state": "ok"' "$TMP/status-offline.json"
(cd "$P" && "${CLI[@]}" status --check-upstream --json > "$TMP/checked.json")
assert_fixed_contains '"state": "update_available"' "$TMP/checked.json"
assert_fixed_contains '"fetches"' "$TMP/checked.json"

# --- a bare update leaves the pin alone and names the command that moves it ---
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-update.json"
(cd "$P" && "${CLI[@]}" update --json > "$TMP/update-sweep.json")
assert_fixed_contains '"action": "skipped"' "$TMP/update-sweep.json"
cmp -s "$TMP/remotes-before-update.json" "$P/.capshelf/remotes.lock.json"

# --- a named update moves the pin, with consent ---
(cd "$P" && "${CLI[@]}" update skills/pdf --yes --json > "$TMP/update.json")
assert_fixed_contains '"action": "updated"' "$TMP/update.json"
assert_fixed_contains 'Extract text and tables' "$P/.agents/skills/pdf/SKILL.md"

# --- share --adopt transfers it into the shelf and releases the remote row ---
(cd "$P" && "${CLI[@]}" share skills/pdf --adopt --json -m 'adopt pdf' > "$TMP/adopt.json")
assert_fixed_contains '"adoptedFrom": "remote"' "$TMP/adopt.json"
assert_fixed_contains '"previousOwnerReleased": true' "$TMP/adopt.json"
test -f "$DATA/skills/pdf/SKILL.md"
assert_fixed_contains 'upstreamPath: skills/pdf' "$DATA/skills/pdf/.capshelf.yml"
assert_fixed_contains '"items": {}' "$P/.capshelf/remotes.lock.json"
test -z "$(git -C "$DATA" status --porcelain)"
# A skill adopts into local scope unless --to says otherwise, and a local-scope
# item keeps its exclude. The project-scope adopt, which must drop the exclude
# before it snapshots through project Git, is covered in cli-remote-lifecycle.
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

# --- rm removes a pulled skill, its alias, and its row ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/xlsx --yes --json >/dev/null)
test -f "$P/.agents/skills/xlsx/SKILL.md"
(cd "$P" && "${CLI[@]}" rm skills/xlsx --yes --json > "$TMP/rm.json")
assert_fixed_contains '"source": "remote"' "$TMP/rm.json"
test ! -e "$P/.agents/skills/xlsx"
test ! -e "$P/.claude/skills/xlsx"
assert_fixed_not_contains '.agents/skills/xlsx/' "$P/.git/info/exclude"

# --- the project ends clean ---
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

rm -rf "$TMP"
echo "✓ smoke-remote"
