#!/usr/bin/env bash
# Shared parts of the performance tools. Source this file; do not run it.
#
# Every tool builds its fixture from scratch. Commit dates are fixed, so two
# builds of one shape give the same commit ids, and the outputs of two
# binaries can be compared byte for byte.

# Shape of the fixture. Override any of these in the environment.
SKILLS="${SKILLS:-30}"         # copy-directory items (skills)
SUBAGENTS="${SUBAGENTS:-10}"   # copy-target-file items (subagents)
SETTINGS="${SETTINGS:-3}"      # fragment items (settings)
SPLIT="${SPLIT:-0}"            # 1: one data-repo commit per item
EXTRA="${EXTRA:-0}"            # non-item files in the data repo

# An isolated environment: no user Git configuration, no self-update check,
# no terminal, and fixed commit dates.
perf_env() {
  local work="$1"
  export HOME="$work/home"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z"
  export GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
  export CAPSHELF_NO_SELF_UPDATE=1 CI=1
  mkdir -p "$HOME"
}

# perf_fixture <binary> <work-dir>
# Builds <work-dir>/data (the data repo) and <work-dir>/project (a project
# with every item installed and committed). Removes <work-dir> first.
perf_fixture() {
  local bin="$1" work="$2" data project item dir i
  rm -rf "$work"
  mkdir -p "$work"
  perf_env "$work"
  data="$work/data"
  project="$work/project"
  mkdir -p "$data" "$project"

  for i in $(seq -w 1 "$SKILLS"); do
    dir="$data/skills/skill-$i"
    mkdir -p "$dir/refs"
    printf -- '---\nname: skill-%s\ndescription: Skill %s.\n---\n\nBody %s.\n' "$i" "$i" "$i" > "$dir/SKILL.md"
    printf 'ref a %s\n' "$i" > "$dir/refs/a.md"
    printf 'ref b %s\n' "$i" > "$dir/refs/b.md"
  done
  for i in $(seq -w 1 "$SUBAGENTS"); do
    dir="$data/subagents/agent-$i"
    mkdir -p "$dir"
    printf -- '---\nname: agent-%s\ndescription: Agent %s.\n---\n\nDo %s.\n' "$i" "$i" "$i" > "$dir/claude.md"
    printf 'name = "agent-%s"\ndescription = "Agent %s."\ndeveloper_instructions = "Do %s."\n' "$i" "$i" "$i" > "$dir/codex.toml"
  done
  for i in $(seq 1 "$SETTINGS"); do
    dir="$data/settings/frag-$i"
    mkdir -p "$dir"
    printf '{"permissions":{"deny":["Bash(tool%s *)"]}}\n' "$i" > "$dir/settings.json"
  done
  if [ "$EXTRA" -gt 0 ]; then
    mkdir -p "$data/docs"
    for i in $(seq 1 "$EXTRA"); do printf 'doc %s\n' "$i" > "$data/docs/d$i.md"; done
  fi

  git -C "$data" init -q -b main
  git -C "$data" config user.email perf@example.invalid
  git -C "$data" config user.name perf
  git -C "$data" remote add origin https://example.invalid/perf-data.git
  if [ "$SPLIT" = 1 ]; then
    git -C "$data" add -A docs 2>/dev/null || true
    git -C "$data" commit -qm docs --allow-empty
    for dir in "$data"/skills/* "$data"/subagents/* "$data"/settings/*; do
      git -C "$data" add -A "$dir"
      git -C "$data" commit -qm "add ${dir#"$data"/}"
    done
  else
    git -C "$data" add -A
    git -C "$data" commit -qm items
  fi

  git -C "$project" init -q -b main
  git -C "$project" config user.email perf@example.invalid
  git -C "$project" config user.name perf
  (cd "$project" && "$bin" init --data ../data --no-pick > /dev/null)
  for dir in "$data"/skills/* "$data"/subagents/* "$data"/settings/*; do
    item="${dir#"$data"/}"
    (cd "$project" && "$bin" add "$item" --yes > /dev/null)
  done
  git -C "$project" add -A
  git -C "$project" commit -qm "install items" || true
}

# perf_change_upstream <work-dir>: one data-repo commit that changes every item.
perf_change_upstream() {
  local data="$1/data" dir
  shopt -s nullglob
  for dir in "$data"/skills/*; do echo "more" >> "$dir/SKILL.md"; done
  for dir in "$data"/subagents/*; do echo "more" >> "$dir/claude.md"; done
  for dir in "$data"/settings/*; do sed -i.bak 's/tool/toolx/' "$dir/settings.json"; rm -f "$dir/settings.json.bak"; done
  git -C "$data" add -A
  git -C "$data" commit -qm "change every item"
}
