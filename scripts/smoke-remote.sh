#!/usr/bin/env bash
set -euo pipefail

# One non-interactive pass over the remote-skill workflow: install from a
# repository URL, list, report offline, check the upstream, move the pin, and
# transfer ownership into the shelf.
#
# The upstream is a local bare repository. `git clone` from github.com is not
# available in the project container, and the harness rule is that every fetch
# in the suite uses a local bare repository.
#
# `smoke-lib.sh` detaches stdin; it does not pass `--yes`. Every destructive or
# consent-gated call below passes its own, or it refuses with exit 3.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
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

# --- the upstream: a bare repository holding two skills on `main` ---
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

# --- add --list: reports the repository and writes nothing ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --list --json > "$TMP/list.json")
assert_fixed_contains '"skills/pdf"' "$TMP/list.json"
assert_fixed_contains '"skills/xlsx"' "$TMP/list.json"
test ! -e "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/pdf"

# --- a plugin-layout upstream: two plugins, one with an agent reference ---
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

# --- add --list --json: the plugins array, and the facts on the plugin skill ---
(cd "$P" && "${CLI[@]}" add "$PLUGIN_URL" --list --json > "$TMP/plugin-list.json")
assert_fixed_contains '"plugins": [' "$TMP/plugin-list.json"
assert_fixed_contains '"source": "plugins/plain"' "$TMP/plugin-list.json"
assert_fixed_contains '"source": "plugins/heavy"' "$TMP/plugin-list.json"
assert_fixed_contains '"usesPluginParts"' "$TMP/plugin-list.json"

# --- --path <plugin root> refuses, exit 3, names the skill and its uses ---
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

# --- --path <skill> --yes installs the skill directory only ---
(cd "$P" && "${CLI[@]}" add "$PLUGIN_URL" --path plugins/heavy/skills/worker --yes --json \
  > "$TMP/plugin-skill.json" 2> "$TMP/plugin-skill.err")
assert_fixed_contains '"usesPluginParts"' "$TMP/plugin-skill.json"
test -f "$P/.agents/skills/worker/SKILL.md"
test ! -e "$P/.agents/skills/worker/agents"
assert_fixed_contains 'uses parts of the heavy plugin' "$TMP/plugin-skill.err"

# --- D9 PTY: a listing taller than a 3-row terminal asks before it shows the
#     rest. `script` opens a real pty, so the terminal-rows gate actually
#     fires, which a piped non-tty run never would. ---
CLI_STR="$(printf '%q ' "${CLI[@]}")"
D9_CMD="cd '$P' && $CLI_STR add '$PLUGIN_URL' --list"
echo n | script -qec "stty rows 3; $D9_CMD" /dev/null > "$TMP/d9.txt"
assert_fixed_contains 'Show all 2 skills' "$TMP/d9.txt"
assert_fixed_contains 'one plugin:   capshelf add' "$TMP/d9.txt"
assert_fixed_contains 'everything:   capshelf add' "$TMP/d9.txt"
assert_fixed_not_contains 'install one:' "$TMP/d9.txt"

# --- D9 PTY: Ctrl-C ---
# The design says Ctrl-C at this question acts as "no", the same as EOF
# (closing stdin with Ctrl-D, which the command above answered correctly
# through the readline 'close' race). A real terminal does not deliver Ctrl-C
# that way: with no SIGINT handler installed anywhere in the CLI, the tty line
# discipline sends SIGINT straight to the process, which dies before Node's
# readline ever sees a keystroke. The run below exits by signal (130), not
# "as no" (0). This is a real gap between the design and the binary — see the
# task report — not fixed here.
set +e
printf '\003' | timeout 15 script -qec "stty rows 3; $D9_CMD" /dev/null \
  > "$TMP/d9-ctrlc.txt" 2>&1
CTRLC_EXIT=$?
set -e
if [ "$CTRLC_EXIT" -eq 0 ]; then
  echo "Ctrl-C at the D9 question exited 0; the known SIGINT gap may be fixed now — update docs/cli.md and this comment"
  exit 1
fi

# The one invariant that must hold either way: a process killed mid-prompt
# leaves no half-finished install. The D9 question never writes by itself, so
# this reuses the same signal against the per-skill consent prompt, which
# does gate a real write, with the as-yet-uninstalled `plain` skill.
INSTALL_CMD="cd '$P' && $CLI_STR add '$PLUGIN_URL' --path plugins/plain/skills/plain"
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-ctrlc.json"
set +e
printf '\003' | timeout 15 script -qec "$INSTALL_CMD" /dev/null \
  > "$TMP/install-ctrlc.txt" 2>&1
INSTALL_CTRLC_EXIT=$?
set -e
if [ "$INSTALL_CTRLC_EXIT" -eq 0 ]; then
  echo "Ctrl-C at the install prompt exited 0; the known SIGINT gap may be fixed now — update docs/cli.md and this comment"
  exit 1
fi
cmp -s "$TMP/remotes-before-ctrlc.json" "$P/.capshelf/remotes.lock.json"
test ! -e "$P/.agents/skills/plain"

(cd "$P" && "${CLI[@]}" rm skills/worker --yes --json >/dev/null)

# --- two candidates without a terminal refuse and name the two flags ---
if (cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --yes --json > "$TMP/ambiguous.json" 2>&1); then
  echo "expected add to refuse an ambiguous repository"
  exit 1
fi
assert_fixed_contains '--path' "$TMP/ambiguous.json"

# --- add <url> --path: installs one skill, records it, commits nothing ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add.json")
assert_fixed_contains '"source": "remote"' "$TMP/add.json"
assert_fixed_contains '"action": "created"' "$TMP/add.json"
test -f "$P/.agents/skills/pdf/SKILL.md"
assert_fixed_contains 'remotes.lock.json' "$P/.capshelf/.gitignore"
test -z "$(git -C "$P" ls-files .capshelf/remotes.lock.json)"
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

# --- a second add of the same URL is a byte-stable no-op ---
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before.json"
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/pdf --yes --json > "$TMP/add-again.json")
assert_fixed_contains '"action": "already-current"' "$TMP/add-again.json"
cmp -s "$TMP/remotes-before.json" "$P/.capshelf/remotes.lock.json"

# --- status: the remote group, offline, never checked ---
(cd "$P" && "${CLI[@]}" status > "$TMP/status.txt")
assert_fixed_contains 'remote/  (skills pinned to repos outside your shelf)' "$TMP/status.txt"
assert_fixed_contains 'never checked' "$TMP/status.txt"
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

# --- the upstream moves; only --check-upstream sees it ---
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

# --- a bare update leaves the pin alone and names the command that moves it ---
cp "$P/.capshelf/remotes.lock.json" "$TMP/remotes-before-update.json"
(cd "$P" && "${CLI[@]}" update --json > "$TMP/update-sweep.json")
assert_fixed_contains '"action": "skipped"' "$TMP/update-sweep.json"
cmp -s "$TMP/remotes-before-update.json" "$P/.capshelf/remotes.lock.json"

# --- a named update moves the pin, with consent ---
(cd "$P" && "${CLI[@]}" update skills/pdf --yes --json > "$TMP/update.json")
assert_fixed_contains '"action": "updated"' "$TMP/update.json"
assert_fixed_contains 'Extract text and tables' "$P/.agents/skills/pdf/SKILL.md"

# --- share --adopt transfers it into the shelf and releases the remote row ---
(cd "$P" && "${CLI[@]}" share skills/pdf --adopt --json -m 'adopt pdf' > "$TMP/adopt.json")
assert_fixed_contains '"adoptedFrom": "remote"' "$TMP/adopt.json"
assert_fixed_contains '"previousOwnerReleased": true' "$TMP/adopt.json"
test -f "$DATA/skills/pdf/SKILL.md"
assert_fixed_contains 'upstreamPath: skills/pdf' "$DATA/skills/pdf/.capshelf.yml"
assert_fixed_contains '"items": {}' "$P/.capshelf/remotes.lock.json"
test -z "$(git -C "$DATA" status --porcelain)"
# A skill adopts into local scope unless --to says otherwise, and a local-scope
# item keeps its exclude. The project-scope adopt, which must drop the exclude
# before it snapshots through project Git, is covered in cli-remote-lifecycle.
assert_fixed_contains '.agents/skills/pdf/' "$P/.git/info/exclude"

# --- rm removes a remote skill, its alias, and its row ---
(cd "$P" && "${CLI[@]}" add "$UPSTREAM_URL" --path skills/xlsx --yes --json >/dev/null)
test -f "$P/.agents/skills/xlsx/SKILL.md"
(cd "$P" && "${CLI[@]}" rm skills/xlsx --yes --json > "$TMP/rm.json")
assert_fixed_contains '"source": "remote"' "$TMP/rm.json"
test ! -e "$P/.agents/skills/xlsx"
test ! -e "$P/.claude/skills/xlsx"
assert_fixed_not_contains '.agents/skills/xlsx/' "$P/.git/info/exclude"

# --- the project ends clean ---
(cd "$P" && "${CLI[@]}" status --strict --json >/dev/null)

rm -rf "$TMP"
echo "✓ smoke-remote"
