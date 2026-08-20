#!/usr/bin/env bash
set -euo pipefail

# Refuse a release whose commit never passed the Test workflow on its own.
#
# Work lands on `main` directly, so a commit can be tagged before anyone knows
# whether it was green. The release jobs re-run the source suites at the tag,
# which catches a broken tree; only this asks whether the commit itself ever
# passed.
#
# Only `push` and `workflow_dispatch` runs count. A `pull_request` run carries
# the head SHA but checks out `refs/pull/<n>/merge` — the commit merged into its
# base — so its success says nothing about the commit standing alone, which is
# what a tag points at.
#
# Usage: require-green-test-run.sh <repository> <sha> [workflow-file]

repository="${1:?repository is required, for example owner/name}"
sha="${2:?commit sha is required}"
workflow="${3:-test.yml}"

state="$(gh api \
  "repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=20" \
  --jq '[.workflow_runs[]
         | select(.event == "push" or .event == "workflow_dispatch")]
        | if length == 0 then "none"
          elif any(.[]; .conclusion == "success") then "success"
          elif all(.[]; .status == "completed") then "failed"
          else "pending" end')"

case "${state}" in
  success)
    printf 'the Test workflow passed on %s\n' "${sha}"
    ;;
  none)
    printf 'no Test run exists for %s.\n' "${sha}" >&2
    printf 'Push the commit to a branch that runs the Test workflow, wait for it to pass, then re-run this release.\n' >&2
    exit 1
    ;;
  failed)
    printf 'every Test run for %s finished without success.\n' "${sha}" >&2
    printf 'Fix the commit and tag the fix; a release is not the place to find this out.\n' >&2
    exit 1
    ;;
  pending)
    printf 'the Test run for %s has not finished.\n' "${sha}" >&2
    printf 'Wait for the Test run, then re-run this release.\n' >&2
    exit 1
    ;;
  *)
    printf 'unexpected run state for %s: %s\n' "${sha}" "${state}" >&2
    exit 1
    ;;
esac
