#!/usr/bin/env bash
set -euo pipefail

# Upstreams are local bare repos because github.com clones are unavailable in
# the project container; smoke-lib detaches stdin without passing --yes, so
# consent-gated calls pass their own.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

smoke_make_tmp
export HOME="$TMP/home"
export XDG_DATA_HOME="$TMP/xdg"
DATA="$TMP/data"
UPSTREAM_WORK="$TMP/upstream-work"
UPSTREAM="$TMP/upstream.git"
P="$TMP/project"

mkdir -p "$HOME" "$XDG_DATA_HOME" "$DATA/skills/placeholder" "$P"
printf '%s\n' '---' 'name: placeholder' '---' '' 'placeholder' \
  > "$DATA/skills/placeholder/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-remote-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

mkdir -p "$UPSTREAM_WORK/skills/pdf" "$UPSTREAM_WORK/skills/xlsx"
printf '%s\n' '---' 'name: pdf' 'description: Extract text' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/pdf/SKILL.md"
printf '%s\n' '---' 'name: xlsx' 'description: Read workbooks' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/xlsx/SKILL.md"
init_git_repo "$UPSTREAM_WORK"
configure_git_user "$UPSTREAM_WORK"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "two skills"
git -C "$UPSTREAM_WORK" branch -M main
git clone -q --bare "$UPSTREAM_WORK" "$UPSTREAM"
git -C "$UPSTREAM_WORK" remote add origin "$UPSTREAM"
UPSTREAM_URL="file://$(canonical_path "$UPSTREAM")"

init_git_repo "$P"
(cd "$P" && "${CLI[@]}" init --data "$DATA" >/dev/null)

(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --list --json > "$TMP/list.json")
assert_fixed_contains '"skills/pdf"' "$TMP/list.json"
assert_fixed_contains '"skills/xlsx"' "$TMP/list.json"
test ! -e "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/pdf"

PLUGIN_UPSTREAM_WORK="$TMP/plugin-upstream-work"
PLUGIN_UPSTREAM="$TMP/plugin-upstream.git"
mkdir -p "$PLUGIN_UPSTREAM_WORK/plugins/plain/skills/plain" \
  "$PLUGIN_UPSTREAM_WORK/plugins/heavy/skills/worker" \
  "$PLUGIN_UPSTREAM_WORK/plugins/heavy/agents" \
  "$PLUGIN_UPSTREAM_WORK/.claude-plugin"
printf '%s\n' '---' 'name: plain' 'description: Plain skill' '---' '' 'body' \
  > "$PLUGIN_UPSTREAM_WORK/plugins/plain/skills/plain/SKILL.md"
printf '%s\n' '---' 'name: worker' 'description: Heavy skill' '---' '' \
  'Dispatches `assistant` for review.' \
  > "$PLUGIN_UPSTREAM_WORK/plugins/heavy/skills/worker/SKILL.md"
printf '%s\n' agent > "$PLUGIN_UPSTREAM_WORK/plugins/heavy/agents/assistant.md"
cat > "$PLUGIN_UPSTREAM_WORK/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "fixture",
  "owner": { "name": "fixture" },
  "plugins": [
    { "name": "plain", "source": "./plugins/plain" },
    { "name": "heavy", "source": "./plugins/heavy" }
  ]
}
JSON
init_git_repo "$PLUGIN_UPSTREAM_WORK"
configure_git_user "$PLUGIN_UPSTREAM_WORK"
git -C "$PLUGIN_UPSTREAM_WORK" add -A
git -C "$PLUGIN_UPSTREAM_WORK" commit -qm "two plugins"
git -C "$PLUGIN_UPSTREAM_WORK" branch -M main
git clone -q --bare "$PLUGIN_UPSTREAM_WORK" "$PLUGIN_UPSTREAM"
git -C "$PLUGIN_UPSTREAM_WORK" remote add origin "$PLUGIN_UPSTREAM"
PLUGIN_URL="file://$(canonical_path "$PLUGIN_UPSTREAM")"

(cd "$P" && "${CLI[@]}" add "$PLUGIN_URL" --list --json > "$TMP/plugin-list.json")
assert_fixed_contains '"plugins": [' "$TMP/plugin-list.json"
assert_fixed_contains '"source": "plugins/plain"' "$TMP/plugin-list.json"
assert_fixed_contains '"source": "plugins/heavy"' "$TMP/plugin-list.json"
assert_fixed_contains '"usesPluginParts"' "$TMP/plugin-list.json"

test ! -e "$P/.capshelf/remotes.lock.json"
set +e
(cd "$P" && "${CLI[@]}" add "$PLUGIN_URL" --path plugins/heavy --yes --json \
  > "$TMP/plugin-root.json" 2>&1)
PLUGIN_ROOT_EXIT=$?
set -e
if [ "$PLUGIN_ROOT_EXIT" -ne 3 ]; then
  echo "expected add --path <plugin root> to exit 3, got $PLUGIN_ROOT_EXIT"
  exit 1
fi
assert_fixed_contains 'is a plugin, not a skill' "$TMP/plugin-root.json"
assert_fixed_contains 'install the skill: capshelf add' "$TMP/plugin-root.json"
test ! -e "$P/.agents/skills/worker"
test ! -e "$P/.capshelf/remotes.lock.json"

(cd "$P" && "${CLI[@]}" add "$PLUGIN_URL" --path plugins/heavy/skills/worker --yes --json \
  > "$TMP/plugin-skill.json" 2> "$TMP/plugin-skill.err")
assert_fixed_contains '"usesPluginParts"' "$TMP/plugin-skill.json"
test -f "$P/.agents/skills/worker/SKILL.md"
test ! -e "$P/.agents/skills/worker/agents"
assert_fixed_contains 'uses parts of the heavy plugin' "$TMP/plugin-skill.err"

# The pty driver opens the terminal because Ctrl-C must wait for the prompt, so
# stdin must stay open; BSD `script` on macOS can't take a FIFO stdin (it is a
# socket) and fails with tcgetattr/ioctl errors.
PTY_DRIVER="$ROOT/e2e/support/pty-driver.py"
ctrl_c_at() {
  local cmd="$1" text="$2" out="$3" steps="$TMP/pty-steps.json"
  python3 -c 'import json, sys; print(json.dumps([{"waitFor": sys.argv[1], "send": "\u0003"}]))' \
    "$text" > "$steps"
  set +e
  timeout 30 python3 "$PTY_DRIVER" --interactions-after-raw "$steps" \
    bash -c "$cmd" > "$out" 2>&1
  PTY_EXIT=$?
  set -e
  if [ "$PTY_EXIT" -eq 124 ]; then
    echo "timed out waiting for '$text' or after Ctrl-C; output:"
    cat "$out"
    exit 1
  fi
  if ! grep -qF -- "$text" "$out"; then
    echo "expected '$text' before Ctrl-C; output:"
    cat "$out"
    exit 1
  fi
}

# util-linux `script` takes the command via `-c`; BSD `script` on macOS has no
# `-c` and takes it as trailing arguments.
PTY_STYLE=""
if command -v script >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1 &&
  command -v python3 >/dev/null 2>&1; then
  if timeout 5 script -qec true /dev/null </dev/null >/dev/null 2>&1; then
    PTY_STYLE=util-linux
  elif timeout 5 script -qe /dev/null true </dev/null >/dev/null 2>&1; then
    PTY_STYLE=bsd
  fi
fi
pty_argv() {
  if [ "$PTY_STYLE" = util-linux ]; then
    PTY_ARGV=(script -qec "$1" /dev/null)
  else
    PTY_ARGV=(script -qe /dev/null bash -c "$1")
  fi
}

if [ -n "$PTY_STYLE" ]; then
  CLI_STR="$(printf '%q ' "${CLI[@]}")"
  D9_CMD="cd '$P' && $CLI_STR add '$PLUGIN_URL' --list"

  # A real pty is needed so the terminal-rows gate fires; a piped non-tty run
  # never would.
  pty_argv "stty rows 3; $D9_CMD"
  echo n | timeout 15 "${PTY_ARGV[@]}" > "$TMP/d9.txt"
  assert_fixed_contains 'Show all 2 skills' "$TMP/d9.txt"
  assert_fixed_contains 'one plugin:   capshelf add' "$TMP/d9.txt"
  assert_fixed_contains 'everything:   capshelf add' "$TMP/d9.txt"
  assert_fixed_not_contains 'install one:' "$TMP/d9.txt"

  # Readline holds the terminal in raw mode so Ctrl-C is a key, not a SIGINT;
  # sent before the question opens it is a tty SIGINT (exit 130) and proves
  # nothing.
  ctrl_c_at "stty rows 3; $D9_CMD" 'Show all 2 skills' "$TMP/d9-ctrlc.txt"
  if [ "$PTY_EXIT" -ne 0 ]; then
    echo "expected Ctrl-C at the D9 question to exit 0, got $PTY_EXIT"
    exit 1
  fi
  assert_fixed_contains 'everything:   capshelf add' "$TMP/d9-ctrlc.txt"
  assert_fixed_not_contains 'install one:' "$TMP/d9-ctrlc.txt"
  assert_fixed_not_contains 'Plain skill' "$TMP/d9-ctrlc.txt"
  assert_fixed_not_contains 'Heavy skill' "$TMP/d9-ctrlc.txt"

  INSTALL_CMD="cd '$P' && $CLI_STR add '$PLUGIN_URL' --path plugins/plain/skills/plain"
  cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-ctrlc.json"
  ctrl_c_at "$INSTALL_CMD" 'Install it? [y/N]' "$TMP/install-ctrlc.txt"
  if [ "$PTY_EXIT" -ne 1 ]; then
    echo "expected Ctrl-C at the install prompt to exit 1, got $PTY_EXIT"
    exit 1
  fi
  assert_fixed_contains 'prompt closed before an answer' "$TMP/install-ctrlc.txt"
  cmp -s "$TMP/remotes-before-ctrlc.json" "$P/.capshelf/remotes.lock.json"
  test ! -e "$P/.agents/skills/plain"
else
  echo "skip: PTY cases need 'timeout', 'python3', and a 'script' that runs a command in a pty"
fi

(cd "$P" && "${CLI[@]}" rm skills/worker --yes --json >/dev/null)

if (cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --yes --json > "$TMP/ambiguous.json" 2>&1); then
  echo "expected add to refuse an ambiguous repository"
  exit 1
fi
assert_fixed_contains '--path' "$TMP/ambiguous.json"

(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add.json")
assert_fixed_contains '"source": "remote"' "$TMP/add.json"
assert_fixed_contains '"action": "created"' "$TMP/add.json"
test -f "$P/.agents/skills/pdf/SKILL.md"
assert_fixed_contains 'remotes.lock.json' "$P/.capshelf/.gitignore"
test -z "$(git -C "$P" ls-files .capshelf/remotes.lock.json)"
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before.json"
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add-again.json")
assert_fixed_contains '"action": "already-current"' "$TMP/add-again.json"
cmp -s "$TMP/remotes-before.json" "$P/.capshelf/remotes.lock.json"

(cd "$P" && "${CLI[@]}" status > "$TMP/status.txt")
assert_fixed_contains 'remote/  (items pinned to repos outside your shelf)' "$TMP/status.txt"
assert_fixed_contains 'never checked' "$TMP/status.txt"
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

printf '%s\n' '---' 'name: pdf' 'description: Extract text and tables' '---' '' 'body' \
  > "$UPSTREAM_WORK/skills/pdf/SKILL.md"
git -C "$UPSTREAM_WORK" add -A
git -C "$UPSTREAM_WORK" commit -qm "revise pdf"
git -C "$UPSTREAM_WORK" push -q origin main

(cd "$P" && "${CLI[@]}" status --json > "$TMP/status-offline.json")
assert_fixed_contains '"state": "ok"' "$TMP/status-offline.json"
(cd "$P" && "${CLI[@]}" status --check-upstream --json > "$TMP/checked.json")
assert_fixed_contains '"state": "update_available"' "$TMP/checked.json"
assert_fixed_contains '"fetches"' "$TMP/checked.json"

cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-update.json"
(cd "$P" && "${CLI[@]}" update --json > "$TMP/update-sweep.json")
assert_fixed_contains '"action": "skipped"' "$TMP/update-sweep.json"
cmp -s "$TMP/remotes-before-update.json" "$P/.capshelf/remotes.lock.json"

(cd "$P" && "${CLI[@]}" update skills/pdf --yes --json > "$TMP/update.json")
assert_fixed_contains '"action": "updated"' "$TMP/update.json"
assert_fixed_contains 'Extract text and tables' "$P/.agents/skills/pdf/SKILL.md"

(cd "$P" && "${CLI[@]}" share skills/pdf --adopt --json -m 'adopt pdf' > "$TMP/adopt.json")
assert_fixed_contains '"adoptedFrom": "remote"' "$TMP/adopt.json"
assert_fixed_contains '"previousOwnerReleased": true' "$TMP/adopt.json"
test -f "$DATA/skills/pdf/SKILL.md"
assert_fixed_contains 'upstreamPath: skills/pdf' "$DATA/skills/pdf/.capshelf.yml"
assert_fixed_contains '"items": {}' "$P/.capshelf/remotes.lock.json"
test -z "$(git -C "$DATA" status --porcelain)"
# A local-scope item keeps its exclude; a project-scope adopt must drop it
# before snapshotting through project Git (covered in cli-remote-lifecycle).
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/xlsx --yes --json >/dev/null)
test -f "$P/.agents/skills/xlsx/SKILL.md"
(cd "$P" && "${CLI[@]}" rm skills/xlsx --yes --json > "$TMP/rm.json")
assert_fixed_contains '"source": "remote"' "$TMP/rm.json"
test ! -e "$P/.agents/skills/xlsx"
test ! -e "$P/.claude/skills/xlsx"
assert_fixed_not_contains '.agents/skills/xlsx/' "$P/.git/info/exclude"

(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

rm -rf "$TMP"
echo "✓ smoke-remote"
