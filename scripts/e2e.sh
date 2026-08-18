#!/usr/bin/env bash
set -euo pipefail

# Run the end-to-end scenarios against one compiled executable.
#
#   scripts/e2e.sh              build dist/capshelf, then test it
#   scripts/e2e.sh --no-build   test the executable CAPSHELF_E2E_BIN names
#
# `--no-build` exists for the release lane, which points CAPSHELF_E2E_BIN at an
# extracted candidate archive and must not be able to rebuild it: a rebuilt
# binary is a different artifact from the one that was validated.
#
# The check below covers the one mistake this script can catch — an unset
# variable, which would otherwise fail every scenario file with the same
# message. What a valid executable *is* — absolute, present, executable, not a
# source file — is decided in e2e/support/binary.ts, before any test world
# exists, and is not restated here.

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

if [ "${1:-}" = "--no-build" ]; then
  shift
else
  bun run build
  export CAPSHELF_E2E_BIN="$ROOT/dist/capshelf"
fi

if [ -z "${CAPSHELF_E2E_BIN:-}" ]; then
  printf 'CAPSHELF_E2E_BIN is not set.\n' >&2
  printf 'Run "bun run e2e" to build and test the host binary, or set it to an\n' >&2
  printf 'absolute path to a compiled capshelf executable.\n' >&2
  exit 1
fi

exec bun test ./e2e "$@"
