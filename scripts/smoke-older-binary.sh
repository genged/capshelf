#!/usr/bin/env bash
set -euo pipefail

# 0.13 runs from its own source at tag v0.13.0 with this tree's node_modules; it
# must refuse a plugin project with "upgrade capshelf" and leave the manifest
# and locks byte-identical, because it cannot write a v5 lock.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

# Skip when a local clone lacks the tag; in CI a missing tag means the checkout
# is wrong, so fail.
if ! git -C "$ROOT" rev-parse -q --verify 'v0.13.0^{commit}' >/dev/null; then
  if [ -n "${CI:-}" ]; then
    echo "smoke-older-binary: tag v0.13.0 is not in this clone, and CI is set." >&2
    echo "  The CI checkout must fetch tags (actions/checkout with fetch-depth: 0)." >&2
    exit 1
  fi
  echo "SKIP smoke-older-binary: tag v0.13.0 is not in this clone"
  exit 0
fi

smoke_make_tmp
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

# A missing file is recorded as a marker so an old command that creates it is
# caught.
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
  # 0.13 does not know the plugins kind, so its ref parser can refuse a plugin
  # ref before reading any file.
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
  "move skills/placeholder --to local" \
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

# `data upstream` saves the manifest without reading the lock, so only the fence
# stops it.
expect_refusal "$P" data upstream https://github.com/o/r
assert_fixed_contains 'declares "shelves"' "$REFUSAL"

# A fresh clone has no local.json, so 0.13 `init` goes on to read the manifest,
# as for a teammate cloning a plugin project.
C="$TMP/clone"
cp -R "$P" "$C"
rm -f "$C/.capshelf/local.json" "$C/.capshelf/local.lock.json"
snapshot "$C" "$TMP/snap-clone"
expect_refusal "$C" init --no-pick
expect_refusal "$C" init --data "$DATA" --no-pick
test ! -e "$C/.capshelf/local.json"

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

echo "✓ smoke-older-binary"
