#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"

mkdir -p "$HOME" "$DATA/codex/config/defaults" "$A/sub"
cat > "$DATA/codex/config/defaults/config.toml" <<'TOML'
model = "gpt-5"
sandbox = "workspace-write"
TOML
init_git_repo "$DATA"
configure_git_user "$DATA"
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"

(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
mkdir -p "$A/.codex"
cat > "$A/.codex/config.toml" <<'TOML'
profile = "local"
TOML

(cd "$A" && "${CLI[@]}" add codex-config/defaults --json > "$TMP/codex-add.json")
assert_fixed_contains 'model = "gpt-5"' "$A/.codex/config.toml"
assert_fixed_contains 'profile = "local"' "$A/.codex/config.toml"

CODEX_PATH="$(cd "$A" && "${CLI[@]}" get-path codex-config/defaults)"
if [[ "$(canonical_path "$CODEX_PATH")" != "$(canonical_path "$DATA/codex/config/defaults/config.toml")" ]]; then
  echo "unexpected codex-config get-path: $CODEX_PATH"
  exit 1
fi
OUTPUT_PATH="$(cd "$A" && "${CLI[@]}" get-path codex-config/defaults --output)"
if [[ "$(canonical_path "$OUTPUT_PATH")" != "$(canonical_path "$A/.codex/config.toml")" ]]; then
  echo "unexpected codex-config output path: $OUTPUT_PATH"
  exit 1
fi

cat > "$DATA/codex/config/defaults/config.toml" <<'TOML'
model = "gpt-5.1"
sandbox = "danger-full-access"
TOML
git -C "$DATA" add codex/config/defaults/config.toml
git -C "$DATA" commit -qm 'codex defaults v2'
(cd "$A" && "${CLI[@]}" update codex-config/defaults --json > "$TMP/codex-update.json")
assert_fixed_contains 'model = "gpt-5.1"' "$A/.codex/config.toml"
assert_fixed_contains 'profile = "local"' "$A/.codex/config.toml"

perl -0pi -e 's/model = "gpt-5.1"\\n//' "$A/.codex/config.toml"
(cd "$A" && "${CLI[@]}" revert codex-config/defaults --json > "$TMP/codex-revert.json")
assert_fixed_contains 'model = "gpt-5.1"' "$A/.codex/config.toml"

(cd "$A" && "${CLI[@]}" rm codex-config/defaults --json > "$TMP/codex-rm.json")
assert_fixed_contains 'profile = "local"' "$A/.codex/config.toml"
assert_fixed_not_contains 'gpt-5.1' "$A/.codex/config.toml"

(cd "$A" && "${CLI[@]}" add codex-config/defaults --json > "$TMP/codex-readd.json")
cat > "$DATA/codex/config/defaults/config.toml" <<'TOML'
model = "gpt-5.2"
sandbox = "workspace-write"
TOML
(cd "$A" && "${CLI[@]}" promote codex-config/defaults -m 'codex defaults v3' --json > "$TMP/codex-promote.json")
assert_contains '"action": "promoted"' "$TMP/codex-promote.json"
assert_fixed_contains 'model = "gpt-5.2"' "$A/.codex/config.toml"

echo "✓ smoke-codex-config ok ($TMP)"
