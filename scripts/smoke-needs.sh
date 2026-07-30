#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
RUNFREE_PROJECT="$TMP/runfree-project"
PLAIN_PROJECT="$TMP/plain-project"

mkdir -p \
  "$HOME" \
  "$DATA/pi/extensions/exa-mcp" \
  "$RUNFREE_PROJECT" \
  "$PLAIN_PROJECT"
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
git -C "$RUNFREE_PROJECT" init -q --initial-branch=main
git -C "$PLAIN_PROJECT" init -q --initial-branch=main

(cd "$RUNFREE_PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
mkdir -p "$RUNFREE_PROJECT/.runfree"
(cd "$RUNFREE_PROJECT" && "${CLI[@]}" add pi-extensions/exa-mcp > "$TMP/add.txt")
assert_fixed_contains \
  'mcp.exa.ai — allow with: runfree host add mcp.exa.ai' \
  "$TMP/add.txt"
assert_fixed_contains \
  'reads env: EXA_API_KEY · needs on PATH: agent-browser' \
  "$TMP/add.txt"

printf '%s\n' '{"domains":["MCP.EXA.AI"]}' \
  > "$RUNFREE_PROJECT/.runfree/network-policy.json"
(cd "$RUNFREE_PROJECT" && "${CLI[@]}" status --strict > "$TMP/status-allowed.txt")
assert_fixed_not_contains 'runfree host add' "$TMP/status-allowed.txt"

cp \
  "$RUNFREE_PROJECT/.pi/extensions/exa-mcp/index.ts" \
  "$TMP/index-before.ts"
cp \
  "$RUNFREE_PROJECT/.capshelf/capshelf.lock.json" \
  "$TMP/lock-before.json"
printf '%s\n' \
  'needs:' \
  '  network: [mcp.exa.ai, api.example.com]' \
  '  env: [EXA_API_KEY]' \
  '  bin: [agent-browser]' \
  > "$DATA/pi/extensions/exa-mcp/.capshelf.yml"
git -C "$DATA" add pi/extensions/exa-mcp/.capshelf.yml
git -C "$DATA" commit -qm 'expand declared needs'

(cd "$RUNFREE_PROJECT" && "${CLI[@]}" status > "$TMP/status-stale.txt")
assert_fixed_contains 'requirements update available' "$TMP/status-stale.txt"
(cd "$RUNFREE_PROJECT" && "${CLI[@]}" update pi-extensions/exa-mcp >/dev/null)
cmp -s \
  "$TMP/index-before.ts" \
  "$RUNFREE_PROJECT/.pi/extensions/exa-mcp/index.ts"
python3 - \
  "$TMP/lock-before.json" \
  "$RUNFREE_PROJECT/.capshelf/capshelf.lock.json" <<'PY'
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

(cd "$PLAIN_PROJECT" && "${CLI[@]}" init --data "$DATA" >/dev/null)
(cd "$PLAIN_PROJECT" && "${CLI[@]}" add pi-extensions/exa-mcp > "$TMP/plain-add.txt")
assert_fixed_not_contains 'needs network egress' "$TMP/plain-add.txt"
assert_fixed_not_contains 'runfree host add' "$TMP/plain-add.txt"

echo "✓ smoke-needs ok ($TMP)"
