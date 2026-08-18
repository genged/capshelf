#!/usr/bin/env bash
set -euo pipefail

# Build the host binary, then run the E2E suite against that exact file.
# `bun run e2e:run` never builds: a release lane points CAPSHELF_E2E_BIN at an
# extracted candidate archive and must not be able to rebuild it.

ROOT="${CAPSHELF_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

bun run build

export CAPSHELF_E2E_BIN="$ROOT/dist/capshelf"
exec bun run e2e:run "$@"
