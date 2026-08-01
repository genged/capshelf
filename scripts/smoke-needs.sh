#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
PROJECT="$TMP/project"

mkdir -p \
  "$HOME" \
  "$DATA/pi/extensions/exa-mcp" \
  "$PROJECT"
printf '%s\n' 'export default {};' > "$DATA/pi/extensions/exa-mcp/index.ts"
printf '%s\n' \
  'needs:' \
  '  network: [mcp.exa.ai]' \
  '  env: [EXA_API_KEY]' \
  '  bin: [agent-browser]' \
  > "$DATA/pi/extensions/exa-mcp/.capshelf.yml"
git -C "$DATA" init -q --initial-branch=main
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-needs-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
git -C "$PROJECT" init -q --initial-branch=main

(cd "$PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$PROJECT" && "${CLI[@]}" add pi-extensions/exa-mcp > "$TMP/add.txt")
assert_fixed_contains \
  'reads env: EXA_API_KEY · needs on PATH: agent-browser' \
  "$TMP/add.txt"
(cd "$PROJECT" && "${CLI[@]}" show pi-extensions/exa-mcp --no-content > "$TMP/show.txt")
assert_fixed_contains 'needs network: mcp.exa.ai' "$TMP/show.txt"
(cd "$PROJECT" && "${CLI[@]}" status --strict >/dev/null)

cp \
  "$PROJECT/.pi/extensions/exa-mcp/index.ts" \
  "$TMP/index-before.ts"
cp \
  "$PROJECT/.capshelf/capshelf.lock.json" \
  "$TMP/lock-before.json"
printf '%s\n' \
  'needs:' \
  '  network: [mcp.exa.ai, api.example.com]' \
  '  env: [EXA_API_KEY]' \
  '  bin: [agent-browser]' \
  > "$DATA/pi/extensions/exa-mcp/.capshelf.yml"
git -C "$DATA" add pi/extensions/exa-mcp/.capshelf.yml
git -C "$DATA" commit -qm 'expand declared needs'

(cd "$PROJECT" && "${CLI[@]}" status > "$TMP/status-stale.txt")
assert_fixed_contains 'requirements update available' "$TMP/status-stale.txt"
(cd "$PROJECT" && "${CLI[@]}" update pi-extensions/exa-mcp >/dev/null)
cmp -s \
  "$TMP/index-before.ts" \
  "$PROJECT/.pi/extensions/exa-mcp/index.ts"
python3 - \
  "$TMP/lock-before.json" \
  "$PROJECT/.capshelf/capshelf.lock.json" <<'PY'
import json
import sys

before = json.load(open(sys.argv[1], encoding="utf-8"))
after = json.load(open(sys.argv[2], encoding="utf-8"))
key = "data/pi-extensions/exa-mcp"
assert before["items"][key]["sha"] == after["items"][key]["sha"]
assert before["items"][key]["sourceCommit"] == after["items"][key]["sourceCommit"]
assert after["items"][key]["needs"]["network"] == [
    "api.example.com",
    "mcp.exa.ai",
]
assert after["version"] == 3
PY

echo "✓ smoke-needs ok ($TMP)"
