#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

mkdir -p "$HOME" "$DATA/mcp/github" "$A/sub"
cat > "$DATA/mcp/github/claude.json" <<'JSON'
{"mcpServers":{"github":{"command":"github-mcp","args":["stdio"]}}}
JSON
cat > "$DATA/mcp/github/codex.toml" <<'TOML'
[mcp_servers.github]
command = "github-mcp"
args = ["stdio"]
enabled = true
TOML
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-mcp-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"

(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$A" && "${CLI[@]}" add mcp/github --json > "$TMP/mcp-add.json")
assert_fixed_contains 'github-mcp' "$A/.mcp.json"
assert_fixed_contains '[mcp_servers.github]' "$A/.codex/config.toml"
if [[ -e "$A/.agents/mcp/github" ]]; then
  echo "unexpected old MCP install directory"
  exit 1
fi

cat > "$A/.mcp.json" <<'JSON'
{"localOnly":true,"mcpServers":{"local":{"command":"local-mcp"},"github":{"command":"github-mcp","args":["stdio"]}}}
JSON
cat > "$A/.codex/config.toml" <<'TOML'
profile = "local"

[mcp_servers.local]
command = "local-mcp"

[mcp_servers.github]
command = "github-mcp"
args = ["stdio"]
enabled = true
TOML

cat > "$DATA/mcp/github/claude.json" <<'JSON'
{"mcpServers":{"github":{"command":"github-mcp-v2","args":["stdio"]}}}
JSON
cat > "$DATA/mcp/github/codex.toml" <<'TOML'
[mcp_servers.github]
command = "github-mcp-v2"
args = ["stdio"]
enabled = false
TOML
git -C "$DATA" add mcp/github
git -C "$DATA" commit -qm 'github mcp v2'
MCP_COMMIT="$(git -C "$DATA" log -1 --format=%H -- mcp/github)"

(cd "$A" && "${CLI[@]}" status mcp/github --json > "$TMP/mcp-status.json")
assert_contains '"state": "update_available"' "$TMP/mcp-status.json"
(cd "$A" && "${CLI[@]}" update mcp/github --dry-run --json > "$TMP/mcp-dry-run.json")
assert_contains '"action": "would-update"' "$TMP/mcp-dry-run.json"
assert_contains "$MCP_COMMIT" "$TMP/mcp-dry-run.json"
assert_fixed_contains 'github-mcp"' "$A/.mcp.json"
assert_fixed_not_contains "$MCP_COMMIT" "$A/.capshelf/capshelf.lock.json"

(cd "$A" && "${CLI[@]}" update mcp/github --json > "$TMP/mcp-update.json")
assert_fixed_contains 'github-mcp-v2' "$A/.mcp.json"
assert_fixed_contains 'localOnly' "$A/.mcp.json"
assert_fixed_contains 'profile = "local"' "$A/.codex/config.toml"
assert_fixed_contains 'enabled = false' "$A/.codex/config.toml"

cat > "$A/.mcp.json" <<'JSON'
{"localOnly":true,"mcpServers":{"github":{"args":["stdio"]}}}
JSON
perl -0pi -e 's/command = "github-mcp-v2"\\n//' "$A/.codex/config.toml"
if (cd "$A" && "${CLI[@]}" status mcp/github --strict >/dev/null 2>&1); then
  echo "expected strict status to fail on output drift"
  exit 1
fi
(cd "$A" && "${CLI[@]}" apply mcp/github --json > "$TMP/mcp-apply.json")
assert_fixed_contains 'github-mcp-v2' "$A/.mcp.json"
assert_fixed_contains 'command = "github-mcp-v2"' "$A/.codex/config.toml"

cat > "$DATA/mcp/github/codex.toml" <<'TOML'
[mcp_servers.github]
command = "github-mcp-v3"
args = ["stdio"]
enabled = true
TOML
(cd "$A" && "${CLI[@]}" promote mcp/github -m 'github mcp v3' --json > "$TMP/mcp-promote.json")
assert_contains '"action": "promoted"' "$TMP/mcp-promote.json"
assert_fixed_contains 'github-mcp-v3' "$A/.codex/config.toml"

echo "✓ smoke-mcp ok ($TMP)"
