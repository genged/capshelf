#!/usr/bin/env bash
# Time a fixed command sequence and count the Git processes of each command.
#
# Usage: tools/perf/bench.sh <binary> [<binary> ...]
# Shape: SKILLS, SUBAGENTS, SETTINGS, SPLIT, EXTRA (see tools/perf/lib.sh).
# Work:  PERF_WORK (default: a new temporary directory, removed at the end).
#
# Each binary gets its own fixture of the same shape. The columns show wall
# seconds and Git processes. `CAPSHELF_GIT_MEASURE=1` makes capshelf print the
# process count on stderr when it exits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tools/perf/lib.sh
. "$HERE/lib.sh"

[ "$#" -ge 1 ] || { echo "usage: $0 <binary> [<binary> ...]" >&2; exit 2; }
WORK_ROOT="${PERF_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/capshelf-perf-XXXXXX")}"
trap '[ -n "${PERF_WORK:-}" ] || rm -rf "$WORK_ROOT"' EXIT
exec < /dev/null

STEPS=(
  "version|--version"
  "ls|ls"
  "status|status"
  "status --diff|status --diff"
  "apply --dry-run|apply --dry-run"
  "apply|apply --yes"
  "update (nothing new)|update --yes"
  "@change"
  "status (updates)|status"
  "update --dry-run (all changed)|update --dry-run"
  "update (all changed)|update --yes"
  "status (after update)|status"
  "apply (after update)|apply --yes"
)

# run_one <binary> <work-dir> <args...>: prints "seconds spawns".
run_one() {
  local bin="$1" work="$2" err t0 t1 spawns rc=0
  shift 2
  err="$work/stderr"
  t0=$(date +%s%N)
  (cd "$work/project" && CAPSHELF_GIT_MEASURE=1 "$bin" "$@" > /dev/null 2> "$err") || rc=$?
  t1=$(date +%s%N)
  spawns=$(grep -o '"totalSpawns":[0-9]*' "$err" | tail -1 | cut -d: -f2 || true)
  printf '%6.3fs %5s%s' "$(echo "($t1 - $t0) / 1000000000" | bc -l)" "${spawns:--}" \
    "$([ "$rc" = 0 ] || printf ' rc=%s' "$rc")"
}

declare -A RESULT
index=0
for bin in "$@"; do
  index=$((index + 1))
  bin="$(realpath "$bin")"
  work="$WORK_ROOT/bin-$index"
  perf_fixture "$bin" "$work"
  for step in "${STEPS[@]}"; do
    if [ "$step" = "@change" ]; then
      perf_change_upstream "$work"
      continue
    fi
    label="${step%%|*}"
    # The arguments of a step are plain words, so word splitting is intended.
    # shellcheck disable=SC2086
    RESULT["$index|$label"]="$(run_one "$bin" "$work" ${step#*|})"
  done
done

printf 'shape: SKILLS=%s SUBAGENTS=%s SETTINGS=%s SPLIT=%s EXTRA=%s\n' \
  "$SKILLS" "$SUBAGENTS" "$SETTINGS" "$SPLIT" "$EXTRA"
printf '%-32s' "command"
for i in $(seq 1 "$#"); do printf ' | %-18s' "binary $i (s, git)"; done
printf '\n'
for step in "${STEPS[@]}"; do
  [ "$step" = "@change" ] && continue
  label="${step%%|*}"
  printf '%-32s' "$label"
  for i in $(seq 1 "$#"); do printf ' | %-18s' "${RESULT["$i|$label"]}"; done
  printf '\n'
done
