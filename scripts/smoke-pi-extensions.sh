#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/smoke-lib.sh"

TMP="$(mktemp -d)"
export HOME="$TMP/home"
DATA="$TMP/data"
A="$TMP/project-a"
B="$TMP/project-b"
EXT="$DATA/pi/extensions/path-guard"

mkdir -p "$HOME" "$EXT/src" "$A" "$B"
printf '%s\n' "export { rules } from './src/rules';" > "$EXT/index.ts"
printf '%s\n' "export const rules = ['v1'];" > "$EXT/src/rules.ts"
printf '%s\n' '{"dependencies":{"minimatch":"^10.0.0"}}' > "$EXT/package.json"
printf '%s\n' 'description: Protect sensitive paths.' 'tags: [safety]' > "$EXT/.capshelf.yml"
init_git_repo "$DATA"
configure_git_user "$DATA"
set_portable_origin "$DATA" smoke-pi-extensions-data
git -C "$DATA" add -A
git -C "$DATA" commit -qm baseline
init_git_repo "$A"
init_git_repo "$B"

(cd "$A" && "${CLI[@]}" init --data ../data >/dev/null)
(cd "$B" && "${CLI[@]}" init --data ../data >/dev/null)

# Both projects pin v1 so a promote in A cannot mutate B implicitly.
(cd "$A" && "${CLI[@]}" add pi-extensions/path-guard --json > "$TMP/add-a.json")
(cd "$B" && "${CLI[@]}" add pi-extensions/path-guard --json > "$TMP/add-b.json")
assert_contains '"type": "pi_extension_executes_code"' "$TMP/add-a.json"
assert_contains '"type": "pi_extension_dependencies_not_installed"' "$TMP/add-a.json"
test -f "$A/.pi/extensions/path-guard/index.ts"
test -f "$A/.pi/extensions/path-guard/src/rules.ts"
test ! -e "$A/.pi/extensions/path-guard/.capshelf.yml"

(cd "$A" && "${CLI[@]}" status pi-extensions/path-guard --strict --json > "$TMP/status-current.json")
assert_contains '"state": "ok"' "$TMP/status-current.json"
assert_contains '"type": "pi_extension_executes_code"' "$TMP/status-current.json"

printf '%s\n' "export const rules = ['promoted'];" > "$A/.pi/extensions/path-guard/src/rules.ts"
(cd "$A" && "${CLI[@]}" status pi-extensions/path-guard --json > "$TMP/status-drift.json")
assert_contains '"state": "drifted_local"' "$TMP/status-drift.json"

(cd "$A" && "${CLI[@]}" promote pi-extensions/path-guard -m 'update path guard' --json > "$TMP/promote.json")
assert_contains '"action": "promoted"' "$TMP/promote.json"
assert_contains "promoted" "$EXT/src/rules.ts"
assert_contains 'tags: \[safety\]' "$EXT/.capshelf.yml"
(cd "$A" && "${CLI[@]}" status pi-extensions/path-guard --strict --json >/dev/null)

# B remains on v1 until its explicit update.
assert_contains "v1" "$B/.pi/extensions/path-guard/src/rules.ts"
(cd "$B" && "${CLI[@]}" status pi-extensions/path-guard --json > "$TMP/status-update.json")
assert_contains '"state": "update_available"' "$TMP/status-update.json"
assert_contains "v1" "$B/.pi/extensions/path-guard/src/rules.ts"
(cd "$B" && "${CLI[@]}" update pi-extensions/path-guard --json >/dev/null)
assert_contains "promoted" "$B/.pi/extensions/path-guard/src/rules.ts"
(cd "$B" && "${CLI[@]}" status pi-extensions/path-guard --strict --json >/dev/null)

echo "✓ smoke-pi-extensions ok ($TMP)"
