#!/usr/bin/env bash
# End-to-end cover for provable source pins: the CRLF failure that motivated
# lock version 4, the migration that repairs an already-broken project, and the
# repair path for a pin whose commit is gone. Everything here runs through the
# real CLI process, so it exercises the shipped exit codes and output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
PROJECT="$TMP/project"
LOCAL_PROJECT="$TMP/plain-project"

mkdir -p "$HOME" "$DATA/skills/csv-report" "$PROJECT" "$LOCAL_PROJECT"

# The original field report: a generator writes CRLF, `core.autocrlf=input`
# normalizes it into the object store, and `git status` reports clean.
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

# S1: `add` delivers git's copy — LF, the same bytes every clone produces — so
# `apply` agrees instead of failing forever with a hash mismatch.
if grep -q $'\r' "$PROJECT/.agents/skills/csv-report/template.csv"; then
  echo "add must deliver the committed bytes, not the working copy" >&2
  exit 1
fi
(cd "$PROJECT" && "${CLI[@]}" apply > "$TMP/apply.txt")
assert_fixed_contains 'already-current' "$TMP/apply.txt"
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

# S7: a teammate's checkout rewrites the installed file. The prompt still
# appears — capshelf cannot prove nobody typed it — but it now says what kind
# of difference it is.
printf 'a,b\r\nc,d\r\n' > "$PROJECT/.agents/skills/csv-report/template.csv"
(cd "$PROJECT" && "${CLI[@]}" status skills/csv-report > "$TMP/drift.txt")
assert_fixed_contains 'line-endings' "$TMP/drift.txt"
# `status --diff` must show it. Under the old no-index diff this printed
# nothing on a machine with core.autocrlf=input — the one command the user ran
# to investigate was blind to the very setting that caused the bug.
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

# S12: repair an already-broken pin. A commit that no longer exists leaves
# `apply` with no target at all, and `update` with a verified one.
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

# PIN-12: a version-3 project refuses every ordinary lock write, migrates in
# one command, and is a no-op the second time.
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
assert_fixed_contains 'already version 4' "$TMP/again.txt"
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

# The same lifecycle in a project that is not a Git repository at all: PIN-5
# says project Git may never decide what managed content is.
(cd "$LOCAL_PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$LOCAL_PROJECT" && "${CLI[@]}" add skills/csv-report --local >/dev/null)
(cd "$LOCAL_PROJECT" && "${CLI[@]}" status --strict >/dev/null)
cmp -s \
  "$PROJECT/.agents/skills/csv-report/template.csv" \
  "$LOCAL_PROJECT/.agents/skills/csv-report/template.csv"

echo "✓ smoke-pins ok ($TMP)"
