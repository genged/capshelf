#!/usr/bin/env bash
set -euo pipefail

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI=(bun run "$ROOT/src/cli.ts")

# Isolate git from global/system config: a global url.<x>.insteadOf rewrite
# would rewrite seeded clone origins and trip upstream checks.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# Detach stdin because `init` offers the picker when stdin and stderr are
# terminals; smoke proves non-interactive behavior and only the e2e pty cells
# prove the picker.
exec < /dev/null

# A passing script removes its `$TMP` to avoid leaving thousands of files; a
# failing one keeps it, and a caller-exported `TMP` is never removed.
SMOKE_OWNED_TMP=""
smoke_make_tmp() {
  SMOKE_OWNED_TMP="$(mktemp -d)"
  TMP="$SMOKE_OWNED_TMP"
}
smoke_remove_tmp_on_success() {
  local status=$?
  if [ -n "$SMOKE_OWNED_TMP" ]; then
    if [ "$status" = 0 ] && [ "${CAPSHELF_KEEP_SMOKE_TMP:-}" != 1 ]; then
      rm -rf "$SMOKE_OWNED_TMP"
    else
      echo "kept smoke files: $SMOKE_OWNED_TMP" >&2
    fi
  fi
  return "$status"
}
trap smoke_remove_tmp_on_success EXIT

init_git_repo() {
  local repo="$1"
  git -C "$repo" init -q
}

configure_git_user() {
  local repo="$1"
  git -C "$repo" config user.email capshelf@example.invalid
  git -C "$repo" config user.name capshelf
}

set_portable_origin() {
  local repo="$1"
  local name="${2:-$(basename "$repo")}"
  git -C "$repo" remote add origin "https://example.invalid/$name.git"
}

canonical_path() {
  local path="$1"
  local dir
  local base
  dir="$(dirname "$path")"
  base="$(basename "$path")"
  (cd "$dir" && printf '%s/%s\n' "$(pwd -P)" "$base")
}

assert_contains() {
  local pattern="$1"
  local path="$2"
  grep -E -q -- "$pattern" "$path"
}

assert_not_contains() {
  local pattern="$1"
  local path="$2"
  if grep -E -q -- "$pattern" "$path"; then
    echo "unexpected match in $path: $pattern"
    exit 1
  fi
}

assert_fixed_contains() {
  local pattern="$1"
  local path="$2"
  grep -F -q -- "$pattern" "$path"
}

assert_fixed_not_contains() {
  local pattern="$1"
  local path="$2"
  if grep -F -q -- "$pattern" "$path"; then
    echo "unexpected fixed-string match in $path: $pattern"
    exit 1
  fi
}
