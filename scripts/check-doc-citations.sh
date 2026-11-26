#!/usr/bin/env bash
# Published docs carry no file:line citations: readers can't act on them and
# edits above make them wrong; fenced blocks are exempt.
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,21p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

PATTERN='`[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+:[0-9]+`|`:[0-9]+`'

violations=0

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
