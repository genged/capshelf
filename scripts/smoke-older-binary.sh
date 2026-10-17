#!/usr/bin/env bash
set -euo pipefail

# Spec D12 and M9: capshelf 0.13 must refuse a plugin project, and must leave
# the manifest and both locks byte for byte. 0.13 runs from its own source at
# tag v0.13.0, with this tree's node_modules (the dependencies did not change).
#
# The new CLI arranges each project, because 0.13 cannot write a version 5
# lock. Then each 0.13 command runs against it. Every command must exit
# non-zero, say "upgrade capshelf", and change none of the snapshot files.
#
# A command that names a plugin can fail at 0.13's item ref parser before it
# reads a file. That still proves the files stay the same. `data upstream`
# never reads the lock, so it must fail at the fence: the `shelves` key.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

if ! git -C "$ROOT" rev-parse -q --verify 'v0.13.0^{commit}' >/dev/null; then
  echo "SKIP smoke-older-binary: tag v0.13.0 is not in this clone"
  exit 0
fi

TMP="$(mktemp -d)"
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/xdg"
export XDG_CONFIG_HOME="$TMP/config"
DATA="$TMP/data"
OLD="$TMP/capshelf-0.13"
P="$TMP/project"
L="$TMP/local-project"

mkdir -p "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$OLD" "$P" "$L"
git -C "$ROOT" archive v0.13.0 | tar -x -C "$OLD"
ln -s "$ROOT/node_modules" "$OLD/node_modules"
(cd "$OLD" && bun run build:ui >/dev/null)
OLD_CLI=(bun run "$OLD/src/cli.ts")

# --- the shelf: one skill 0.13 knows, and one plugin it does not ---
mkdir -p "$DATA/skills/placeholder" "$DATA/plugins/x/.claude-plugin" \
  "$DATA/plugins/x/skills/x"
printf '%s\n' '---' 'name: placeholder' '---' '' 'placeholder' \
  > "$DATA/skills/placeholder/SKILL.md"
printf '%s\n' '{"name":"x","version":"1.0.0"}' \
  > "$DATA/plugins/x/.claude-plugin/plugin.json"
printf '%s\n' '---' 'name: x' 'description: x' '---' '' 'body' \
  > "$DATA/plugins/x/skills/x/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-older-binary-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

# Copy each snapshot file to "$2". A file that does not exist is recorded as
# a marker, so an old command that creates it is caught too.
snapshot() {
  local project="$1" dest="$2" file
  mkdir -p "$dest"
  for file in capshelf.json capshelf.lock.json local.json local.lock.json; do
    if [ -e "$project/.capshelf/$file" ]; then
      cp "$project/.capshelf/$file" "$dest/$file"
    else
      printf 'absent\n' > "$dest/$file.absent"
    fi
  done
}

assert_snapshot() {
  local project="$1" dest="$2" label="$3" file
  for file in capshelf.json capshelf.lock.json local.json local.lock.json; do
    if [ -e "$dest/$file.absent" ]; then
      if [ -e "$project/.capshelf/$file" ]; then
        echo "0.13 $label created .capshelf/$file"
        exit 1
      fi
    elif ! cmp -s "$dest/$file" "$project/.capshelf/$file"; then
      echo "0.13 $label changed .capshelf/$file"
      diff "$dest/$file" "$project/.capshelf/$file" || true
      exit 1
    fi
  done
}

# Run one 0.13 command in "$1" with the rest as its arguments. It must exit
# non-zero, print "upgrade capshelf", and leave every snapshot file the same.
# Sets REFUSAL to the file that holds its stderr.
expect_refusal() {
  local project="$1" label
  shift
  label="$*"
  REFUSAL="$TMP/refusal.err"
  set +e
  (cd "$project" && "${OLD_CLI[@]}" "$@" >/dev/null 2>"$REFUSAL")
  local code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    echo "expected 0.13 '$label' to refuse, but it exited 0"
    exit 1
  fi
  local expected='upgrade capshelf'
  # 0.13 does not know the plugins kind, so its ref parser can refuse a
  # plugin ref before any file is read.
  case "$label" in
    *plugins/*) expected='upgrade capshelf|invalid item kind "plugins"' ;;
  esac
  if ! grep -E -q -- "$expected" "$REFUSAL"; then
    echo "expected 0.13 '$label' to match '$expected'; stderr:"
    cat "$REFUSAL"
    exit 1
  fi
  assert_snapshot "$project" "$TMP/snap-$(basename "$project")" "$label"
}

# --- arrange: a project-scope plugin, written by this tree's CLI ---
init_git_repo "$P"
(cd "$P" && "${CLI[@]}" init --data "$DATA" --no-pick >/dev/null)
(cd "$P" && "${CLI[@]}" add skills/placeholder >/dev/null)
(cd "$P" && "${CLI[@]}" add plugins/x >/dev/null)
assert_fixed_contains '"shelves"' "$P/.capshelf/capshelf.json"
assert_fixed_contains '"version": 5' "$P/.capshelf/capshelf.lock.json"
snapshot "$P" "$TMP/snap-project"

for args in \
  "add skills/placeholder" \
  "rm skills/placeholder --yes" \
  "update" \
  "apply" \
  "move plugins/x --to local" \
  "promote skills/placeholder -m smoke" \
  "keep-local skills/placeholder" \
  "revert skills/placeholder --yes" \
  "lock migrate" \
  "data bind $DATA" \
  "share skills/placeholder --to project -m smoke"; do
  # shellcheck disable=SC2086 # each entry is a word list on purpose
  expect_refusal "$P" $args
done

# `data upstream` saves the manifest and never reads the lock, so only the
# fence stops it.
expect_refusal "$P" data upstream https://github.com/o/r
assert_fixed_contains 'declares "shelves"' "$REFUSAL"

# --- init: a fresh clone has no local.json, so 0.13 init goes on to read the
#     manifest. This is the teammate who clones a plugin project. ---
C="$TMP/clone"
cp -R "$P" "$C"
rm -f "$C/.capshelf/local.json" "$C/.capshelf/local.lock.json"
snapshot "$C" "$TMP/snap-clone"
expect_refusal "$C" init --no-pick
expect_refusal "$C" init --data "$DATA" --no-pick
test ! -e "$C/.capshelf/local.json"

# --- arrange: a local-scope plugin, so only local.json holds the fence ---
init_git_repo "$L"
(cd "$L" && "${CLI[@]}" init --data "$DATA" --no-pick >/dev/null)
(cd "$L" && "${CLI[@]}" add skills/placeholder --local >/dev/null)
(cd "$L" && "${CLI[@]}" add plugins/x --local >/dev/null)
assert_fixed_contains '"shelves"' "$L/.capshelf/local.json"
assert_fixed_not_contains '"shelves"' "$L/.capshelf/capshelf.json"
snapshot "$L" "$TMP/snap-local-project"

expect_refusal "$L" rm skills/placeholder --local --yes
expect_refusal "$L" keep-local skills/placeholder --local
expect_refusal "$L" rm plugins/x --local --yes
expect_refusal "$L" keep-local plugins/x --local

rm -rf "$TMP"
echo "✓ smoke-older-binary"
