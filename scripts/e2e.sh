#!/usr/bin/env bash
set -euo pipefail

# `--no-build` exists so the release lane cannot rebuild the extracted candidate
# archive; a rebuilt binary is a different artifact from the one validated.

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

# Match the unit suite's four workers because more workers slowed that suite
# on a 12-core host due to process startup.
exec bun test --parallel="${E2E_JOBS:-4}" ./e2e "$@"
