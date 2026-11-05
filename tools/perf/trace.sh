#!/usr/bin/env bash
# List the Git commands that one capshelf command runs, grouped and counted.
#
# Usage: tools/perf/trace.sh <binary> <capshelf args...>
# Shape: SKILLS, SUBAGENTS, SETTINGS, SPLIT, EXTRA (see tools/perf/lib.sh).
# Work:  PERF_WORK (default: a new temporary directory, removed at the end).
#
# A `git` script first on PATH logs each argument list, then runs the real
# Git. Commit ids and item numbers are masked, so one line counts the same
# call for every item. A line with a count near the item count is a call that
# runs once per item.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/perf/lib.sh
. "$HERE/lib.sh"

[ "$#" -ge 2 ] || { echo "usage: $0 <binary> <capshelf args...>" >&2; exit 2; }
BIN="$(realpath "$1")"
shift
WORK_ROOT="${PERF_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/capshelf-perf-XXXXXX")}"
trap '[ -n "${PERF_WORK:-}" ] || rm -rf "$WORK_ROOT"' EXIT
exec < /dev/null

REAL_GIT="$(command -v git)"
perf_fixture "$BIN" "$WORK_ROOT/fixture"

SHIM="$WORK_ROOT/shim"
LOG="$WORK_ROOT/git.log"
mkdir -p "$SHIM"
cat > "$SHIM/git" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$LOG"
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$SHIM/git"
: > "$LOG"

rc=0
(cd "$WORK_ROOT/fixture/project" && PATH="$SHIM:$PATH" "$BIN" "$@" > /dev/null 2>&1) || rc=$?
echo "exit code: $rc, git processes: $(wc -l < "$LOG" | tr -d ' ')"
sed -E 's/-C [^ ]+ //; s/[0-9a-f]{40,64}/<sha>/g; s/(skill|agent)-[0-9]+/\1-N/g; s/frag-[0-9]+/frag-N/g; s/capshelf-attrs-[A-Za-z0-9]+/capshelf-attrs-X/g' "$LOG" \
  | cut -c1-160 | sort | uniq -c | sort -rn
