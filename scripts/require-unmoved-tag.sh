#!/usr/bin/env bash
set -euo pipefail

# Refuse to publish when the tag no longer names the commit that was validated.
#
# The release gate approves one commit and every job builds that commit. A tag
# can be moved in between, and the release about to be created would then
# describe bytes nobody validated.
#
# Usage: require-unmoved-tag.sh <repository> <tag> <validated-sha>

repository="${1:?repository is required, for example owner/name}"
tag="${2:?tag is required}"
validated="${3:?validated sha is required}"

current="$(gh api "repos/${repository}/commits/${tag}" --jq .sha)"

if [ "${current}" != "${validated}" ]; then
  printf '%s moved: validated %s, now %s\n' "${tag}" "${validated}" "${current}" >&2
  printf 'Re-run the release so the moved tag is validated on its own terms.\n' >&2
  exit 1
fi

printf '%s still points at the validated commit %s\n' "${tag}" "${validated}"
