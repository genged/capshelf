#!/usr/bin/env bash
# Released version docs are frozen: editing one makes the repo disagree with
# what users already have, so even a restore is refused.
set -euo pipefail

NOTES_DIR="docs/release-notes"
DOC_PATHS=("$NOTES_DIR" "docs/whats-new-*.md")

# What's New pages before 0.6 were revised after tagging; grandfather them
# rather than freeze a breach nobody can fix.
WHATS_NEW_FROZEN_FROM="0.6.0"

MODE="guard"
BASE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --audit) MODE="audit" ;;
    --base)
      shift
      BASE="${1-}"
      [ -n "$BASE" ] || { echo "--base needs a ref" >&2; exit 2; }
      ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
# No early exit when a directory is absent: wholesale removal is a violation.

violations=0
reported=""

normalize_version() {
  case "$1" in
    *.*.*) printf '%s' "$1" ;;
    *) printf '%s.0' "$1" ;;
  esac
}

frozen_from() {
  case "$1" in
    docs/whats-new-*) printf '%s' "$WHATS_NEW_FROZEN_FROM" ;;
    *) printf '' ;;
  esac
}

is_frozen() {
  local path="$1" version floor
  version="$(normalize_version "$2")"
  floor="$(frozen_from "$path")"
  [ -n "$floor" ] || return 0
  [ "$(printf '%s\n%s\n' "$floor" "$version" | sort -V | head -1)" = "$floor" ]
}

docs_for_tag() {
  local tag="$1" version major minor patch
  version="${tag#v}"
  IFS=. read -r major minor patch <<<"$version"
  printf '%s/release-notes-%s.md %s\n' "$NOTES_DIR" "$version" "$version"
  if [ "${patch:-0}" = "0" ]; then
    printf 'docs/whats-new-%s.%s.md %s\n' "$major" "$minor" "$version"
  else
    printf 'docs/whats-new-%s.md %s\n' "$version" "$version"
  fi
}

version_of_doc() {
  local base
  base="$(basename "$1" .md)"
  case "$1" in
    "$NOTES_DIR"/*) printf '%s' "${base#release-notes-}" ;;
    docs/whats-new-*) printf '%s' "${base#whats-new-}" ;;
    *) printf '' ;;
  esac
}

if [ "$MODE" = "audit" ]; then
  if [ -z "$(git ls-files -- "${DOC_PATHS[@]}")" ]; then
    echo "no tracked release documentation; nothing to audit"
    exit 0
  fi
  echo "Auditing version-specific release documentation across full history."
  echo
  while IFS= read -r file; do
    mapfile -t commits < <(git log --format=%H --follow -- "$file")
    [ "${#commits[@]}" -gt 1 ] || continue

    version="$(version_of_doc "$file")"
    if [ -n "$version" ] && ! is_frozen "$file" "$version"; then
      continue
    fi
    tag="v$(normalize_version "${version:-0}")"
    git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null || tag=""

    violations=$((violations + 1))
    added="${commits[$(( ${#commits[@]} - 1 ))]}"
    printf '✗ %s\n' "$file"
    printf '    added    %s\n' "$(git log -1 --format='%h %ad  %s' --date=short "$added")"
    for commit in "${commits[@]:0:$(( ${#commits[@]} - 1 ))}"; do
      if [ -z "$tag" ]; then
        when="version never tagged"
      elif git merge-base --is-ancestor "$commit" "$tag" 2>/dev/null; then
        when="before $tag was tagged"
      else
        when="after $tag was tagged"
      fi
      printf '    edited   %s   (%s)\n' \
        "$(git log -1 --format='%h %ad  %s' --date=short "$commit")" "$when"
    done
    echo
  done < <(git ls-files -- "${DOC_PATHS[@]}")

  if [ "$violations" -eq 0 ]; then
    echo "✓ no frozen release document has been edited since it was committed"
    exit 0
  fi
  printf '%s document(s) edited after they were committed.\n' "$violations"
  echo "Published history cannot be rewritten; hold the freeze from here on."
  exit 1
fi

# Compare against the shipped tag rather than a commit range: it holds
# regardless of branch or how long ago the edit landed.
while IFS= read -r tag; do
  while read -r doc version; do
    is_frozen "$doc" "$version" || continue
    git cat-file -e "$tag:$doc" 2>/dev/null || continue
    if [ ! -f "$doc" ]; then
      printf '✗ %s is missing but shipped in %s\n' "$doc" "$tag"
      reported="$reported $doc"
      violations=$((violations + 1))
      continue
    fi
    if ! git show "$tag:$doc" | cmp -s - "$doc"; then
      printf '✗ %s has changed since %s was tagged\n' "$doc" "$tag"
      printf '    git diff %s -- %s\n' "$tag" "$doc"
      reported="$reported $doc"
      violations=$((violations + 1))
    fi
  done < <(docs_for_tag "$tag")
done < <(git tag --list 'v*')

check_range() {
  local label="$1" status path version
  shift
  while IFS=$'\t' read -r status path _; do
    [ -n "${status:-}" ] || continue
    case "$status" in
      A*) continue ;;
    esac
    version="$(version_of_doc "$path")"
    [ -z "$version" ] || is_frozen "$path" "$version" || continue
    case " $reported " in *" $path "*) continue ;; esac
    reported="$reported $path"
    case "$status" in
      D*) printf '✗ %s deleted %s\n' "$path" "$label" ;;
      R*) printf '✗ %s renamed %s\n' "$path" "$label" ;;
      *) printf '✗ %s modified %s\n' "$path" "$label" ;;
    esac
    violations=$((violations + 1))
  done < <(git diff --name-status "$@" -- "${DOC_PATHS[@]}")
}

check_range "in the working tree or index" HEAD

if [ -n "$BASE" ]; then
  if git rev-parse --verify --quiet "$BASE" >/dev/null; then
    check_range "in $BASE..HEAD" "$BASE..HEAD"
  else
    echo "unknown ref: $BASE" >&2
    exit 2
  fi
fi

if [ "$violations" -eq 0 ]; then
  echo "✓ version-specific release documentation is frozen"
  exit 0
fi
echo
echo "A release document describes a version that has shipped."
echo "If the edit is not pushed yet, drop it from the commit that made it."
echo "If it is pushed, the release is already live: leave it, and say what"
echo "changed in the next version's documents."
exit 1
