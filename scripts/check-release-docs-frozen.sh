#!/usr/bin/env bash
# Version-specific release documentation is frozen: once a file describing a
# released version is committed, it must never change.
#
# Two families, both derived from the version being cut:
#   docs/release-notes/release-notes-X.Y.Z.md   the GitHub release body
#   docs/whats-new-X.Y.md  (or -X.Y.Z.md)       the detailed page
#
# Each describes a version that has shipped. Editing one afterwards makes the
# repository disagree with what users already have. There is no legitimate
# edit to carve out: an unpushed mistake is corrected by dropping it from the
# commit that made it, and a pushed one is already live, so there is nothing
# to restore to. A "restore" is therefore refused too.
#
# Modes:
#   (default)  Fail when a released document no longer matches the tag it
#              shipped under, and when any tracked document is edited in the
#              working tree or index.
#   --audit    Report every document whose history contains a post-creation
#              edit, marking which edits landed after that version was tagged.
#
# Options:
#   --base <ref>  Also check commits in <ref>..HEAD. Opt-in: a gate that fails
#                 on history you cannot act on gets switched off.
#
# Exits 0 when clean, 1 when a violation is found, 2 on a usage error.
set -euo pipefail

NOTES_DIR="docs/release-notes"
DOC_PATHS=("$NOTES_DIR" "docs/whats-new-*.md")

# What's New pages predate this policy and several were revised after their
# tag. Grandfather those rather than freeze a breach nobody can fix, and hold
# the line from 0.6 on. Release notes are enforced from the first one, because
# none of them was ever edited.
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
# Deliberately no early exit when a directory is absent: removing one wholesale
# is a violation, not a reason to skip. The tag comparison reads from tags.

violations=0
reported=""

# X.Y -> X.Y.0 so versions compare and map to tags uniformly.
normalize_version() {
  case "$1" in
    *.*.*) printf '%s' "$1" ;;
    *) printf '%s.0' "$1" ;;
  esac
}

# Lowest version this family is frozen from, or empty for "always".
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

# The documents a tag shipped, as "path version" pairs.
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

# The version a tracked document describes, or empty when the name does not
# encode one.
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

# --- guard -------------------------------------------------------------------
# A released document must still be byte-identical to what shipped under its
# tag. That is the contract a user can observe, and unlike a commit range it
# holds regardless of branch or how long ago the edit landed.
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

# Catch the edit before it is committed. `reported` only keeps one file from
# being listed twice; no path is exempt.
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
