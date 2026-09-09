#!/usr/bin/env bash
set -euo pipefail

repository="${1:?repository is required}"
tag="${2:?tag is required}"
sha="${3:?commit sha is required}"
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || ! "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'invalid release target: %s at %s\n' "${tag}" "${sha}" >&2
  exit 1
fi

printf 'ready=false\nversion=%s\n' "${tag#v}" >> "${GITHUB_OUTPUT}"
bash "${scripts}/require-unmoved-tag.sh" "${repository}" "${tag}" "${sha}"

releases="$(gh api "repos/${repository}/releases?per_page=100" --paginate --slurp)"
published="$(jq -r --arg tag "${tag}" 'any(.[][]; .tag_name == $tag and .draft == false)' <<< "${releases}")"
if [ "${published}" = true ]; then
  printf '%s is already published. Skipping this release.\n' "${tag}"
  exit 0
fi

if bash "${scripts}/require-green-test-run.sh" "${repository}" "${sha}"; then
  printf 'ready=true\n' >> "${GITHUB_OUTPUT}"
else
  result=$?
  if [ "${result}" = 2 ]; then
    printf 'Deferred until Test completes for %s. No runner will wait.\n' "${sha}"
    exit 0
  fi
  exit "${result}"
fi
