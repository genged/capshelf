#!/usr/bin/env bash
set -euo pipefail

# A tag can move after the gate approves a commit, and publishing then would
# describe bytes nobody validated.

repository="${1:?repository is required, for example owner/name}"
tag="${2:?tag is required}"
validated="${3:?validated sha is required}"

current="$(gh api "repos/${repository}/commits/refs/tags/${tag}" --jq .sha)"

if [ "${current}" != "${validated}" ]; then
  printf '%s moved: validated %s, now %s\n' "${tag}" "${validated}" "${current}" >&2
  printf 'Re-run the release so the moved tag is validated on its own terms.\n' >&2
  exit 1
fi

printf '%s still points at the validated commit %s\n' "${tag}" "${validated}"
