#!/usr/bin/env bash
# The web UI command from source: `init` registers the project, `ui` starts
# on localhost and prints its URL, the API answers with the token and refuses
# without it, the shell and its assets are served, and the process stops on
# SIGTERM. A headless fetch stands in for the browser.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
export XDG_CONFIG_HOME="$TMP/config"
DATA="$TMP/data"
PROJECT="$TMP/project"

mkdir -p "$HOME" "$DATA/skills/hello" "$PROJECT"
printf '# hello\n\nfirst line\nsecond line\n' > "$DATA/skills/hello/SKILL.md"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-ui-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline

# S1: init registers the project for the UI.
(cd "$PROJECT" && "${CLI[@]}" init --data "$DATA" > "$TMP/init.txt")
assert_fixed_contains 'registered for capshelf ui' "$TMP/init.txt"
[ -f "$XDG_CONFIG_HOME/capshelf/projects.json" ] || {
  echo "init did not write the project registry" >&2
  exit 1
}
(cd "$PROJECT" && "${CLI[@]}" add skills/hello >/dev/null)
# A local edit so the status carries one drifted row.
printf '# hello\n\nfirst line\nedited line\n' > "$PROJECT/.agents/skills/hello/SKILL.md"

# S2: the server starts, prints one JSON line, and keeps running.
(cd "$PROJECT" && exec "${CLI[@]}" ui --no-open --json > "$TMP/ui.json" 2> "$TMP/ui.err") &
UI_PID=$!
cleanup() {
  kill "$UI_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 200); do
  [ -s "$TMP/ui.json" ] && break
  sleep 0.1
done
[ -s "$TMP/ui.json" ] || {
  echo "capshelf ui printed nothing" >&2
  cat "$TMP/ui.err" >&2
  exit 1
}

# S3: the shell and the API, through the token the URL carries.
bun -e '
  const info = JSON.parse(await Bun.file(process.argv[1]).text());
  const project = process.argv[2];
  const url = new URL(info.url);
  const token = url.searchParams.get("t");
  if (!token) throw new Error("the printed URL carries no token");
  const base = url.origin;
  const auth = { Authorization: `Bearer ${token}` };
  const shell = await fetch(`${base}/`);
  if (shell.status !== 200 || !(await shell.text()).includes("<div id=\"app\">")) {
    throw new Error("the shell did not serve");
  }
  for (const asset of ["/app.js", "/app.css", "/logo.png"]) {
    const response = await fetch(`${base}${asset}`);
    if (response.status !== 200) throw new Error(`${asset} did not serve`);
  }
  const refused = await fetch(`${base}/api/overview`);
  if (refused.status !== 401) throw new Error(`no token expected 401, got ${refused.status}`);
  const overview = await (await fetch(`${base}/api/overview`, { headers: auth })).json();
  if (overview.projects.length !== 1) throw new Error("overview did not list the project");
  if (overview.currentProject !== overview.projects[0].path) {
    throw new Error("the current project is not the registered one");
  }
  const statusUrl = new URL(`${base}/api/project/status`);
  statusUrl.searchParams.set("project", overview.projects[0].path);
  const status = await (await fetch(statusUrl, { headers: auth })).json();
  const hello = status.items.find((item) => item.ref === "skills/hello");
  if (!hello || hello.row.state !== "drifted_local" || !hello.attention) {
    throw new Error(`expected a drifted skills/hello row, got ${JSON.stringify(hello)}`);
  }
  if (hello.actions[0].command !== "capshelf promote skills/hello") {
    throw new Error(`unexpected first action: ${hello.actions[0].command}`);
  }
  const diffUrl = new URL(`${base}/api/project/diff`);
  diffUrl.searchParams.set("project", overview.projects[0].path);
  diffUrl.searchParams.set("item", hello.id);
  diffUrl.searchParams.set("view", "installed");
  const diff = await (await fetch(diffUrl, { headers: auth })).json();
  if (!diff.diff || !diff.diff.text.includes("+edited line")) {
    throw new Error("the installed diff did not show the edit");
  }
  const shelfUrl = new URL(`${base}/api/shelf`);
  shelfUrl.searchParams.set("repo", status.dataRepo);
  const shelf = await (await fetch(shelfUrl, { headers: auth })).json();
  if (!shelf.items.some((item) => item.ref === "skills/hello")) {
    throw new Error("the shelf did not list skills/hello");
  }
  process.stdout.write(`ok ${project}\n`);
' "$TMP/ui.json" "$PROJECT" > "$TMP/api.txt"
assert_fixed_contains 'ok ' "$TMP/api.txt"

# S4: SIGTERM stops the server and the command exits 0.
kill "$UI_PID"
set +e
wait "$UI_PID"
UI_EXIT=$?
set -e
trap - EXIT
[ "$UI_EXIT" -eq 0 ] || {
  echo "capshelf ui exited $UI_EXIT after SIGTERM" >&2
  cat "$TMP/ui.err" >&2
  exit 1
}

echo "smoke-ui: ok"
