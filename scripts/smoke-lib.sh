#!/usr/bin/env bash
set -euo pipefail

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI=(bun run "$ROOT/src/cli.ts")

# Isolate git from the machine's global/system config so smoke runs are
# hermetic — a global url.<x>.insteadOf rewrite (proxies, SSH-rewrite setups)
# would otherwise rewrite seeded clone origins and trip upstream checks.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# Detach the whole suite from the terminal's input. `init` offers the picker
# when stdin and stderr are both terminals, so a smoke run started from an
# interactive shell drew the prompt and waited for a keystroke that never
# came. Every script sources this file before its first CLI call, so the
# redirect binds here once instead of each `init` remembering `--no-pick`.
#
# This is the layer boundary, not only a fix: smoke proves non-interactive
# behavior and passes `--yes` for consent, while the picker is terminal
# behavior that only the end-to-end pseudo-terminal cells can prove.
exec < /dev/null

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
