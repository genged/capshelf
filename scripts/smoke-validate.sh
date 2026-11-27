#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

smoke_make_tmp
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

mkdir -p "$HOME" "$DATA/skills/good/references" "$DATA/skills/prose" \
  "$DATA/skills/broken" "$A"
printf '%s\n' '---' 'name: good' \
  'description: Deploy the service when the user asks to ship.' '---' '' \
  '1. Build. Run `make build` and check that it exits 0.' \
  '2. Ship. Read [the notes](references/notes.md), then run `make ship`.' '' \
  '## Troubleshooting' '' '| Failure | Fix |' '|---|---|' \
  '| build fails | run `make clean` first |' \
  > "$DATA/skills/good/SKILL.md"
printf '%s\n' 'notes' > "$DATA/skills/good/references/notes.md"
printf '%s\n' '---' 'name: prose' 'description: Prose only.' '---' '' \
  'Do the work.' > "$DATA/skills/prose/SKILL.md"
printf '%s\n' '---' 'name: other' '---' '' 'Read [notes](missing.md).' \
  > "$DATA/skills/broken/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-validate-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"
(cd "$A" && "${CLI[@]}" init --data ../data --no-pick >/dev/null)

expect_exit() {
  local want="$1"
  local out="$2"
  shift 2
  set +e
  (cd "$A" && "${CLI[@]}" "$@" > "$out" 2>&1)
  local got=$?
  set -e
  if [ "$got" -ne "$want" ]; then
    echo "expected '$*' to exit $want, got $got"
    cat "$out"
    exit 1
  fi
}

expect_exit 0 "$TMP/good.txt" validate skills/good
assert_fixed_contains 'skills/good (data repo)  pass' "$TMP/good.txt"
assert_fixed_contains '1 skill: 1 pass, 0 warn, 0 fail' "$TMP/good.txt"

expect_exit 0 "$TMP/prose.txt" validate skills/prose
assert_fixed_contains 'skills/prose (data repo)  warn' "$TMP/prose.txt"
assert_fixed_contains 'no numbered steps' "$TMP/prose.txt"
expect_exit 4 "$TMP/prose-strict.txt" validate skills/prose --strict

expect_exit 4 "$TMP/all.txt" validate
assert_fixed_contains '"name" is "other" but the directory is "broken"' "$TMP/all.txt"
assert_fixed_contains 'missing.md: no such file' "$TMP/all.txt"
assert_fixed_contains '3 skills: 1 pass, 1 warn, 1 fail' "$TMP/all.txt"

set +e
(cd "$A" && "${CLI[@]}" validate --json > "$TMP/all.json")
JSON_EXIT=$?
set -e
test "$JSON_EXIT" -eq 4
python3 - "$TMP/all.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["summary"] == {"items": 3, "pass": 1, "warn": 1, "fail": 1}, report["summary"]
results = {item["ref"]: item["result"] for item in report["items"]}
assert results == {"skills/broken": "fail", "skills/good": "pass", "skills/prose": "warn"}, results
PY

expect_exit 2 "$TMP/missing.txt" validate skills/nope
test -z "$(git -C "$DATA" status --porcelain)"

(cd "$A" && "${CLI[@]}" add skills/good >/dev/null)
expect_exit 0 "$TMP/here.txt" validate skills/good --here
assert_fixed_contains 'skills/good (project)  pass' "$TMP/here.txt"

echo "✓ smoke-validate ok"
