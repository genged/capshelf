#!/usr/bin/env bash
set -euo pipefail

# One exact Bun version, declared once. A workflow that pins a different
# version — or none — builds and tests with a compiler the repository never
# agreed to, which is the class of difference the E2E layer exists to catch.

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

declared="$(bun -e 'const pkg = await Bun.file("package.json").json(); process.stdout.write((pkg.packageManager ?? "").replace(/^bun@/, ""));')"

if [[ ! "$declared" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf 'package.json#packageManager must pin an exact bun version, got: %s\n' "$declared" >&2
  exit 1
fi

status=0
for workflow in .github/workflows/*.yml; do
  # One workflow is allowed to track the newest Bun on purpose: the canary
  # exists to find an incompatibility before a release does. It declares that
  # with a marker, so the exemption is visible in the file it applies to.
  if grep -q '# bun-pin: intentionally-latest' "$workflow"; then
    continue
  fi
  while IFS= read -r pinned; do
    if [ "$pinned" != "$declared" ]; then
      printf '%s pins bun-version %s, package.json declares %s\n' \
        "$workflow" "$pinned" "$declared" >&2
      status=1
    fi
  done < <(grep -E '^\s*bun-version:' "$workflow" | sed -E 's/.*bun-version:[[:space:]]*//')

  if grep -qE '^\s*uses:\s*oven-sh/setup-bun' "$workflow" &&
    ! grep -qE '^\s*bun-version:' "$workflow"; then
    printf '%s sets up bun without pinning bun-version\n' "$workflow" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  printf 'bun pin: %s in package.json and every workflow\n' "$declared"
fi

# The pin governs CI. A local build with another version is allowed, but it is
# not the version a release is built with, so say so rather than let a local
# result stand in for a released one.
running="$(bun --version)"
if [ "$running" != "$declared" ]; then
  printf 'note: this machine runs bun %s, not the pinned %s\n' \
    "$running" "$declared" >&2
fi

exit "$status"
