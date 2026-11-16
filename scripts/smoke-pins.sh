#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

smoke_make_tmp
export HOME="$TMP/home"
DATA="$TMP/data"
PROJECT="$TMP/project"
LOCAL_PROJECT="$TMP/plain-project"

mkdir -p "$HOME" "$DATA/skills/csv-report" "$PROJECT" "$LOCAL_PROJECT"

# A generator writes CRLF and `core.autocrlf=input` normalizes it in the object
# store, so `git status` reports clean despite differing bytes.
printf '%s\n' '# csv report' > "$DATA/skills/csv-report/SKILL.md"
printf 'a,b\r\nc,d\r\n' > "$DATA/skills/csv-report/template.csv"
git -C "$DATA" init -q --initial-branch=main
git -C "$DATA" config core.autocrlf input
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-pins-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
[ -z "$(git -C "$DATA" status --porcelain)" ] || {
  echo "expected a clean data repo after autocrlf normalization" >&2
  exit 1
}

git -C "$PROJECT" init -q --initial-branch=main
(cd "$PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$PROJECT" && "${CLI[@]}" add skills/csv-report >/dev/null)

# `add` delivers git's LF copy, the same bytes every clone produces, so `apply`
# does not fail forever with a hash mismatch.
if grep -q $'\r' "$PROJECT/.agents/skills/csv-report/template.csv"; then
  echo "add must deliver the committed bytes, not the working copy" >&2
  exit 1
fi
(cd "$PROJECT" && "${CLI[@]}" apply > "$TMP/apply.txt")
assert_fixed_contains 'already-current' "$TMP/apply.txt"
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

# Consent is still required because capshelf cannot prove nobody typed the
# change.
printf 'a,b\r\nc,d\r\n' > "$PROJECT/.agents/skills/csv-report/template.csv"
(cd "$PROJECT" && "${CLI[@]}" status skills/csv-report > "$TMP/drift.txt")
assert_fixed_contains 'line-endings' "$TMP/drift.txt"
# `status --diff` must show line-ending drift even with core.autocrlf=input,
# which a no-index diff hides.
(cd "$PROJECT" && "${CLI[@]}" status skills/csv-report --diff > "$TMP/diff.txt")
assert_fixed_contains 'template.csv' "$TMP/diff.txt"
set +e
(cd "$PROJECT" && "${CLI[@]}" apply skills/csv-report > "$TMP/refused.txt" 2>&1)
REFUSED=$?
set -e
[ "$REFUSED" -eq 3 ] || {
  echo "expected exit 3 for unauthorized loss, got $REFUSED" >&2
  exit 1
}
assert_fixed_contains 'a checkout may have rewritten this file' "$TMP/refused.txt"
(cd "$PROJECT" && "${CLI[@]}" apply skills/csv-report --yes >/dev/null)
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

python3 - "$PROJECT/.capshelf/capshelf.lock.json" <<'PY'
import json
import sys

path = sys.argv[1]
lock = json.load(open(path, encoding="utf-8"))
lock["items"]["data/skills/csv-report"]["sourceCommit"] = "0" * 40
json.dump(lock, open(path, "w", encoding="utf-8"), indent=2)
PY
set +e
(cd "$PROJECT" && "${CLI[@]}" apply skills/csv-report > "$TMP/unresolvable.txt" 2>&1)
UNRESOLVABLE=$?
set -e
[ "$UNRESOLVABLE" -ne 0 ] || {
  echo "expected apply to refuse an unresolvable pin" >&2
  exit 1
}
assert_fixed_contains 'capshelf update skills/csv-report' "$TMP/unresolvable.txt"
printf '%s\n' '# csv report v2' > "$DATA/skills/csv-report/SKILL.md"
git -C "$DATA" add -A
git -C "$DATA" commit -qm v2
(cd "$PROJECT" && "${CLI[@]}" update skills/csv-report --yes >/dev/null)
(cd "$PROJECT" && "${CLI[@]}" apply skills/csv-report > "$TMP/repaired.txt")
assert_fixed_contains 'already-current' "$TMP/repaired.txt"

python3 - "$PROJECT/.capshelf/capshelf.lock.json" <<'PY'
import json
import sys

path = sys.argv[1]
lock = json.load(open(path, encoding="utf-8"))
entry = lock["items"]["data/skills/csv-report"]
entry.pop("sourcePinDigest")
entry["sha"] = "0123456789ab"
lock["version"] = 3
json.dump(lock, open(path, "w", encoding="utf-8"), indent=2)
PY
set +e
(cd "$PROJECT" && "${CLI[@]}" update skills/csv-report > "$TMP/gated.txt" 2>&1)
GATED=$?
set -e
[ "$GATED" -eq 3 ] || {
  echo "expected exit 3 from the lock-writer gate, got $GATED" >&2
  exit 1
}
assert_fixed_contains 'capshelf lock migrate' "$TMP/gated.txt"
(cd "$PROJECT" && "${CLI[@]}" lock migrate --dry-run > "$TMP/dry.txt")
assert_fixed_contains 'Dry run; nothing written.' "$TMP/dry.txt"
(cd "$PROJECT" && "${CLI[@]}" lock migrate > "$TMP/migrated.txt")
assert_fixed_contains 'repaired legacy identity   1' "$TMP/migrated.txt"
(cd "$PROJECT" && "${CLI[@]}" lock migrate > "$TMP/again.txt")
assert_fixed_contains 'already version 5' "$TMP/again.txt"
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

# Project Git must never decide what managed content is, so the lifecycle must
# also work outside a Git repository.
(cd "$LOCAL_PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$LOCAL_PROJECT" && "${CLI[@]}" add skills/csv-report --local >/dev/null)
(cd "$LOCAL_PROJECT" && "${CLI[@]}" status --strict >/dev/null)
cmp -s \
  "$PROJECT/.agents/skills/csv-report/template.csv" \
  "$LOCAL_PROJECT/.agents/skills/csv-report/template.csv"

echo "✓ smoke-pins ok"
