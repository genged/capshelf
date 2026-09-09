#!/usr/bin/env bash
set -euo pipefail

repository="${GITHUB_REPOSITORY:?repository is required}"
event="${GITHUB_EVENT_PATH:?event payload is required}"

case "${GITHUB_EVENT_NAME}" in
  workflow_run)
    if ! jq -e --arg repository "${repository}" '
      .workflow_run | .conclusion == "success"
      and (.event == "push" or .event == "workflow_dispatch")
      and .repository.full_name == $repository
      and .head_repository.full_name == $repository
    ' "${event}" >/dev/null; then
      printf 'targets=[]\n' >> "${GITHUB_OUTPUT}"
      exit 0
    fi
    sha="$(jq -er '.workflow_run.head_sha' "${event}")"
    if [[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
      printf 'invalid Test commit: %s\n' "${sha}" >&2
      exit 1
    fi
    tags="$(gh api "repos/${repository}/tags?per_page=100" --paginate --slurp)"
    targets="$(jq -c --arg sha "${sha}" '
      [ .[][] | select(.commit.sha == $sha)
        | select(.name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
        | {tag: .name, sha: $sha} ] | unique_by(.tag)
    ' <<< "${tags}")"
    ;;
  push|workflow_dispatch)
    if [ "${GITHUB_EVENT_NAME}" = workflow_dispatch ]; then
      tag="$(jq -er '.inputs.tag' "${event}")"
    else
      tag="${GITHUB_REF#refs/tags/}"
    fi
    if [[ ! "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      printf 'tag must look like v0.1.0, got %s\n' "${tag}" >&2
      exit 1
    fi
    sha="$(gh api "repos/${repository}/commits/refs/tags/${tag}" --jq .sha)"
    if [[ ! "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
      printf 'invalid tagged commit: %s\n' "${sha}" >&2
      exit 1
    fi
    targets="$(jq -cn --arg tag "${tag}" --arg sha "${sha}" '[{tag: $tag, sha: $sha}]')"
    ;;
  *)
    printf 'unsupported release event: %s\n' "${GITHUB_EVENT_NAME}" >&2
    exit 1
    ;;
esac

printf 'Release requests: %s\n' "${targets}"
printf 'targets=%s\n' "${targets}" >> "${GITHUB_OUTPUT}"
