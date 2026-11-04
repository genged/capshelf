#!/usr/bin/env bash
# Prove that two binaries behave the same on one tricky fixture.
#
# Usage: tools/perf/equiv.sh <old-binary> <new-binary>
# Shape: SKILLS, SUBAGENTS, SETTINGS, SPLIT, EXTRA (see tools/perf/lib.sh).
#        The defaults here are small: 6 skills, 3 subagents, 2 settings.
# Work:  PERF_WORK (default: a new temporary directory, removed at the end).
#
# Both binaries run the same command sequence on a fixture built at the same
# path. The tool compares stdout, stderr, exit code, the lock, the executable
# bits, and the hash of every installed file. Timestamps are masked. It exits
# 0 when all of them are equal and 1 when any differs.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILLS="${SKILLS:-6}" SUBAGENTS="${SUBAGENTS:-3}" SETTINGS="${SETTINGS:-2}"
# shellcheck source=tools/perf/lib.sh
. "$HERE/lib.sh"

[ "$#" -eq 2 ] || { echo "usage: $0 <old-binary> <new-binary>" >&2; exit 2; }
OLD="$(realpath "$1")"
NEW="$(realpath "$2")"
WORK_ROOT="${PERF_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/capshelf-perf-XXXXXX")}"
trap '[ -n "${PERF_WORK:-}" ] || rm -rf "$WORK_ROOT"' EXIT
exec < /dev/null
W="$WORK_ROOT/fixture"
OUT="$WORK_ROOT/out"

# The command sequence. CLEAN commits nothing: it drops the data-repo edits,
# because `update` refuses a dirty data repo.
STEPS=(
  "status --json" "status --diff" "apply --dry-run --json" "ls --json" "ls"
  "status skills/skill-4 --diff" "status skills/skill-5 --diff --json"
  "status skills/skill-2 --diff-view upstream" "status settings/frag-1 --diff"
  "status skills/café --diff --diff-view all"
  CLEAN
  "update --dry-run --json" "update --yes --json" "status --json"
  "apply --yes --json" "status --json" "update skills/filtered --yes"
  "apply --dry-run"
)

# The extra shapes on top of the shared fixture.
tricky_fixture() {
  local bin="$1" data project
  perf_fixture "$bin" "$W"
  data="$W/data"
  project="$W/project"
  # A unicode item, a unicode file name, an executable, and a deep tree.
  mkdir -p "$data/skills/café/sub/deeper"
  printf -- '---\nname: café\ndescription: Unicode.\n---\n' > "$data/skills/café/SKILL.md"
  printf 'x\n' > "$data/skills/café/sub/deeper/naïve.md"
  printf '#!/bin/sh\necho hi\n' > "$data/skills/café/run.sh"
  chmod +x "$data/skills/café/run.sh"
  # An item that later declares a filter driver, which a re-pin must refuse.
  mkdir -p "$data/skills/filtered"
  printf -- '---\nname: filtered\ndescription: F.\n---\n' > "$data/skills/filtered/SKILL.md"
  git -C "$data" add -A
  git -C "$data" commit -qm "extra shapes"
  (cd "$project" && "$bin" add skills/café --yes > /dev/null 2>&1)
  (cd "$project" && "$bin" add skills/filtered --yes > /dev/null 2>&1)
  # Upstream changes: a filter attribute, a sidecar-only change, content.
  printf 'skills/filtered/** filter=crypt\n' > "$data/.gitattributes"
  printf 'needs:\n  bin: [jq]\n' > "$data/skills/skill-1/.capshelf.yml"
  echo "change" >> "$data/skills/skill-2/SKILL.md"
  echo "change" >> "$data/skills/filtered/SKILL.md"
  echo "change" >> "$data/subagents/agent-1/claude.md"
  sed -i.bak 's/tool1/toolz1/' "$data/settings/frag-1/settings.json"
  rm -f "$data/settings/frag-1/settings.json.bak"
  git -C "$data" add -A
  git -C "$data" commit -qm "upstream changes"
  # A dirty data repo, a drifted install, and a deleted installed file.
  echo "dirty" >> "$data/skills/skill-3/SKILL.md"
  echo "drift" >> "$project/.claude/skills/skill-4/SKILL.md"
  rm -f "$project/.claude/skills/skill-5/refs/a.md"
}

mask() { sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<time>/g'; }

run_sequence() {
  local bin="$1" tag="$2" n=0 args
  tricky_fixture "$bin"
  for args in "${STEPS[@]}"; do
    if [ "$args" = CLEAN ]; then
      git -C "$W/data" checkout -q -- .
      continue
    fi
    n=$((n + 1))
    # The arguments of a step are plain words, so word splitting is intended.
    # shellcheck disable=SC2086
    (cd "$W/project" && "$bin" $args > "$OUT/$tag-$n.out" 2> "$OUT/$tag-$n.err"
     echo "rc=$?" >> "$OUT/$tag-$n.out")
    mask < "$OUT/$tag-$n.out" > "$OUT/$tag-$n.stdout"
    mask < "$OUT/$tag-$n.err" > "$OUT/$tag-$n.stderr"
    rm -f "$OUT/$tag-$n.out" "$OUT/$tag-$n.err"
  done
  (cd "$W/project" && find . -path ./.git -prune -o -type f ! -name '*.lock.json' -print0 \
    | sort -z | xargs -0 sha1sum) > "$OUT/$tag-files"
  (cd "$W/project" && find . -path ./.git -prune -o -type f -perm -u+x -print | sort) > "$OUT/$tag-exec"
  mask < "$W/project/.capshelf/capshelf.lock.json" > "$OUT/$tag-lock"
}

rm -rf "$OUT"
mkdir -p "$OUT"
run_sequence "$OLD" old
run_sequence "$NEW" new
status=0
for old in "$OUT"/old-*; do
  new="${old/old-/new-}"
  if ! cmp -s "$old" "$new"; then
    echo "DIFFERENT: $(basename "${old#*old-}")"
    diff "$old" "$new" | head -20
    status=1
  fi
done
count=$(find "$OUT" -name 'old-*' | wc -l | tr -d ' ')
if [ "$status" = 0 ]; then
  echo "equal: $count outputs, the lock, and every installed file"
fi
exit "$status"
