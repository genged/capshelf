#!/usr/bin/env bash
# Published documentation carries no source line numbers.
#
# AGENTS.md requires a `file:line` citation for a claim about code, so that a
# reviewer can check it. That rule is for documents a reviewer acts on once:
# specs, plans, evidence, reviews, and commit messages, all under `local/` or
# in Git history. Published docs are different. A reader cannot act on a line
# number, and the number is wrong as soon as anyone edits the file above it.
#
# This is not hypothetical. Every `file:line` citation in `docs/` and
# `README.md` arrived in one release cycle, and ten of the sixty-seven pointed
# at a blank line, a closing brace, or an unrelated comment before that release
# had even shipped.
#
# A bare path is fine and often useful: `src/bundled/skills/capshelf/SKILL.md`
# and `scripts/release-platforms.json` name a thing that keeps its name. Only
# the line number is refused.
#
# Fenced code blocks are exempt. A transcript may legitimately show a `grep`
# result or a stack frame.
#
# Frozen release documents are deliberately *not* exempt. None carries a
# citation today, and the only moment one could be removed is before the
# commit that creates it — which is exactly when this gate fires.
#
# Exits 0 when clean, 1 when a citation is found, 2 on a usage error.
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,21p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

# A code-ish path followed by a line number, or the `, :422` continuation form
# that follows one. Both inside backticks, which is how a citation is written.
PATTERN='`[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+:[0-9]+`|`:[0-9]+`'

violations=0

# Strip fenced blocks, keeping real line numbers so the report is clickable.
strip_fences() {
  awk '
    /^[[:space:]]*```/ { fence = !fence; print ""; next }
    { print (fence ? "" : $0) }
  ' "$1"
}

while IFS= read -r doc; do
  [ -f "$doc" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    printf '✗ %s:%s\n' "$doc" "$hit"
    violations=$((violations + 1))
  done < <(strip_fences "$doc" | grep -nE "$PATTERN" || true)
done < <(git ls-files -- 'docs/*.md' 'docs/**/*.md' 'README.md')

if [ "$violations" -eq 0 ]; then
  echo "✓ no source line numbers in published documentation"
  exit 0
fi
printf '\n%s citation(s) name a source line.\n' "$violations"
echo "Published docs state behavior. Put the file:line in the commit message,"
echo "or in the spec, plan, evidence, or review under local/ that needs it."
exit 1
