#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
OUT="$TMP/artifacts"
CODEX_RUNTIME_HOME="$TMP/codex-home"
CODEX_RUNTIME_AVAILABLE="$TMP/codex-available.json"
CODEX_RUNTIME_INSTALL="$TMP/codex-install.json"

mkdir -p "$HOME" "$DATA/skills/review" "$DATA/skills/testing" "$OUT" \
  "$CODEX_RUNTIME_HOME"
printf '%s\n' '---' 'name: review' 'description: Review changes.' '---' \
  > "$DATA/skills/review/SKILL.md"
printf '%s\n' '---' 'name: testing' 'description: Plan tests.' '---' \
  > "$DATA/skills/testing/SKILL.md"
git -C "$DATA" init -q --initial-branch=main
configure_git_user "$DATA"
git -C "$DATA" add skills
git -C "$DATA" commit -qm skills

run_marketplace() {
  (cd "$TMP" && "${CLI[@]}" --data "$DATA" marketplace "$@")
}

run_marketplace init --target claude \
  --name company-workflows --owner Engineering >/dev/null
run_marketplace init --target codex \
  --name company-codex --owner Engineering >/dev/null
run_marketplace plugin create engineering \
  --target claude --skill skills/review --skill skills/testing >/dev/null
run_marketplace plugin create engineering \
  --target codex --skill skills/review >/dev/null

run_marketplace validate --target claude >/dev/null
run_marketplace validate --target codex >/dev/null
assert_fixed_contains '"source": "./"' "$DATA/.claude-plugin/marketplace.json"
assert_fixed_contains '"source": "local"' "$DATA/.agents/plugins/marketplace.json"
assert_fixed_contains '0.0.0+codex.' \
  "$DATA/codex/generated/plugins/engineering/.codex-plugin/plugin.json"
CODEX_MANIFEST="$DATA/codex/generated/plugins/engineering/.codex-plugin/plugin.json"
CODEX_VERSION_BEFORE="$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$CODEX_MANIFEST")"

if command -v codex >/dev/null 2>&1; then
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin marketplace add "$DATA" --json >/dev/null
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin marketplace list --json >"$TMP/codex-marketplaces.json"
  python3 - "$TMP/codex-marketplaces.json" "$DATA" <<'PY'
import json, os, sys
marketplaces = json.load(open(sys.argv[1]))["marketplaces"]
entry = next(item for item in marketplaces if item["name"] == "company-codex")
assert os.path.realpath(entry["root"]) == os.path.realpath(sys.argv[2])
PY
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin list --available --json >"$CODEX_RUNTIME_AVAILABLE"
  python3 - "$CODEX_RUNTIME_AVAILABLE" "$CODEX_VERSION_BEFORE" <<'PY'
import json, sys
available = json.load(open(sys.argv[1]))["available"]
entry = next(item for item in available if item["pluginId"] == "engineering@company-codex")
assert entry["version"] == sys.argv[2]
assert entry["installPolicy"] == "AVAILABLE"
assert entry["authPolicy"] == "ON_INSTALL"
PY
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin add engineering@company-codex --json >"$CODEX_RUNTIME_INSTALL"
  python3 - "$CODEX_RUNTIME_INSTALL" "$CODEX_VERSION_BEFORE" <<'PY'
import json, os, sys
installed = json.load(open(sys.argv[1]))
assert installed["version"] == sys.argv[2]
assert os.path.basename(installed["installedPath"]) == sys.argv[2]
PY
  CODEX_INSTALLED_PATH="$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["installedPath"])' \
    "$CODEX_RUNTIME_INSTALL")"
  cmp "$CODEX_MANIFEST" "$CODEX_INSTALLED_PATH/.codex-plugin/plugin.json"
  cmp "$DATA/codex/generated/plugins/engineering/skills/review/SKILL.md" \
    "$CODEX_INSTALLED_PATH/skills/review/SKILL.md"
fi

mkdir -p "$DATA/notes"
printf '%s\n' 'Unrelated marketplace note.' >"$DATA/notes/runtime.txt"
git -C "$DATA" add notes/runtime.txt
git -C "$DATA" commit -qm 'unrelated marketplace note'
test "$CODEX_VERSION_BEFORE" = "$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$CODEX_MANIFEST")"

printf '%s\n' '---' 'name: review' 'description: Changed review.' '---' \
  > "$DATA/skills/review/SKILL.md"
run_marketplace sync --target codex >/dev/null
assert_fixed_contains 'Changed review.' \
  "$DATA/codex/generated/plugins/engineering/skills/review/SKILL.md"
git -C "$DATA" add skills/review .agents/plugins/marketplace.json codex/generated
git -C "$DATA" commit -qm 'change review and projection'
CODEX_VERSION_CHANGED="$(python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$CODEX_MANIFEST")"
test "$CODEX_VERSION_BEFORE" != "$CODEX_VERSION_CHANGED"

if command -v codex >/dev/null 2>&1; then
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin marketplace add "$DATA" --json >/dev/null
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin marketplace list --json >"$TMP/codex-marketplaces.json"
  python3 - "$TMP/codex-marketplaces.json" "$DATA" <<'PY'
import json, os, sys
marketplaces = json.load(open(sys.argv[1]))["marketplaces"]
entry = next(item for item in marketplaces if item["name"] == "company-codex")
assert os.path.realpath(entry["root"]) == os.path.realpath(sys.argv[2])
PY
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin add engineering@company-codex --json >"$CODEX_RUNTIME_INSTALL"
  python3 - "$CODEX_RUNTIME_INSTALL" "$CODEX_VERSION_CHANGED" <<'PY'
import json, os, sys
installed = json.load(open(sys.argv[1]))
assert installed["version"] == sys.argv[2]
assert os.path.basename(installed["installedPath"]) == sys.argv[2]
PY
  CODEX_INSTALLED_PATH="$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["installedPath"])' \
    "$CODEX_RUNTIME_INSTALL")"
  cmp "$CODEX_MANIFEST" "$CODEX_INSTALLED_PATH/.codex-plugin/plugin.json"
  cmp "$DATA/codex/generated/plugins/engineering/skills/review/SKILL.md" \
    "$CODEX_INSTALLED_PATH/skills/review/SKILL.md"
  CODEX_CACHE_VERSIONS="$(
    for CODEX_CACHE_VERSION_PATH in \
      "$CODEX_RUNTIME_HOME/plugins/cache/company-codex/engineering"/*; do
      if [ -d "$CODEX_CACHE_VERSION_PATH" ]; then
        basename "$CODEX_CACHE_VERSION_PATH"
      fi
    done
  )"
  test "$CODEX_CACHE_VERSIONS" = "$CODEX_VERSION_CHANGED"
  CODEX_HOME="$CODEX_RUNTIME_HOME" \
    codex plugin list --available --json >"$CODEX_RUNTIME_AVAILABLE"
  python3 - "$CODEX_RUNTIME_AVAILABLE" "$CODEX_VERSION_CHANGED" <<'PY'
import json, sys
installed = json.load(open(sys.argv[1]))["installed"]
entry = next(item for item in installed if item["pluginId"] == "engineering@company-codex")
assert entry["version"] == sys.argv[2]
PY
fi

run_marketplace plugin pack engineering \
  --target claude --output "$OUT/engineering.plugin" >/dev/null
run_marketplace plugin pack engineering \
  --target codex --output "$OUT/engineering-codex" >/dev/null
python3 - "$OUT/engineering.plugin" "$TMP/extracted-plugin" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
    archive.extractall(sys.argv[2])
assert ".claude-plugin/plugin.json" in names
assert "skills/review/SKILL.md" in names
assert not any(name.startswith("engineering/") for name in names)
assert not any(name.startswith("setup/") for name in names)
PY
test -f "$OUT/engineering-codex/.agents/plugins/marketplace.json"

if command -v claude >/dev/null 2>&1; then
  (cd "$DATA" && claude plugin validate . >/dev/null)
  claude plugin validate "$TMP/extracted-plugin" >/dev/null
  CLAUDE_RESERVED_ROOT="$TMP/reserved-marketplace"
  CLAUDE_RESERVED_OUTPUT="$TMP/reserved-marketplace-add.txt"
  mkdir -p "$CLAUDE_RESERVED_ROOT/.claude-plugin" \
    "$TMP/claude-runtime-config"
  printf '%s\n' \
    '{' \
    '  "name": "claude-code-marketplace",' \
    '  "owner": { "name": "Engineering" },' \
    '  "plugins": []' \
    '}' >"$CLAUDE_RESERVED_ROOT/.claude-plugin/marketplace.json"
  claude plugin validate "$CLAUDE_RESERVED_ROOT" >/dev/null
  if CLAUDE_CONFIG_DIR="$TMP/claude-runtime-config" \
    claude plugin marketplace add "$CLAUDE_RESERVED_ROOT" \
      >"$CLAUDE_RESERVED_OUTPUT" 2>&1; then
    echo "Claude accepted a reserved marketplace name" >&2
    exit 1
  fi
  assert_fixed_contains "is reserved for official Anthropic marketplaces" \
    "$CLAUDE_RESERVED_OUTPUT"
fi

run_marketplace plugin rename engineering core \
  --target codex >/dev/null
run_marketplace plugin delete engineering \
  --target claude >/dev/null
test -f "$DATA/codex/plugin-definitions/core.json"
test ! -e "$DATA/codex/generated/plugins/engineering"
assert_fixed_contains '"engineering": null' "$DATA/.claude-plugin/marketplace.json"
test -z "$(git -C "$DATA" status --porcelain)"

echo "✓ smoke-marketplace ok ($TMP)"
