#!/usr/bin/env bash
set -euo pipefail

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CLI=(bun run "$ROOT/src/cli.ts")

init_git_repo() {
  local repo="$1"
  git -C "$repo" init -q
}

configure_git_user() {
  local repo="$1"
  git -C "$repo" config user.email capshelf@example.invalid
  git -C "$repo" config user.name capshelf
}

assert_contains() {
  local pattern="$1"
  local path="$2"
  rg -q "$pattern" "$path"
}

assert_not_contains() {
  local pattern="$1"
  local path="$2"
  if rg -q "$pattern" "$path"; then
    echo "unexpected match in $path: $pattern"
    exit 1
  fi
}

assert_fixed_contains() {
  local pattern="$1"
  local path="$2"
  rg -F -q "$pattern" "$path"
}

assert_fixed_not_contains() {
  local pattern="$1"
  local path="$2"
  if rg -F -q "$pattern" "$path"; then
    echo "unexpected fixed-string match in $path: $pattern"
    exit 1
  fi
}
