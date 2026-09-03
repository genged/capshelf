#!/usr/bin/env bash
# Build the sandbox that docs/demo/demo.tape records.
#
# The sandbox is a throwaway HOME under /tmp/capshelf-demo. It holds one data
# repo and two projects, the same three repositories the README transcript
# uses. The tape sources env.sh, which points HOME and PATH at the sandbox, so
# nothing here touches the real home directory.
#
#   /tmp/capshelf-demo/
#     bin/capshelf            compiled from this checkout (or CAPSHELF_DEMO_BIN)
#     env.sh                  sourced by the tape before the first visible line
#     home/code/agent-config  data repo: three skills, one settings fragment
#     home/code/my-app        project, already tracks security-review
#     home/code/other-app     project, tracks nothing yet
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX=/tmp/capshelf-demo
HOME_DIR="$SANDBOX/home"
CODE="$HOME_DIR/code"
DATA="$CODE/agent-config"

rm -rf "$SANDBOX"
mkdir -p "$SANDBOX/bin" "$CODE" "$HOME_DIR/.local/bin"

if [[ -n "${CAPSHELF_DEMO_BIN:-}" ]]; then
  cp "$CAPSHELF_DEMO_BIN" "$SANDBOX/bin/capshelf"
else
  (cd "$ROOT" && bun build --compile --minify --target=bun ./src/cli.ts \
    --outfile="$SANDBOX/bin/capshelf" >/dev/null)
fi
chmod +x "$SANDBOX/bin/capshelf"
ln -s "$SANDBOX/bin/capshelf" "$HOME_DIR/.local/bin/capshelf"

# Git identity for the sandbox only. HOME is redirected, so this file is the
# only global config the demo sees.
cat > "$HOME_DIR/.gitconfig" <<'GITCONFIG'
[user]
	name = Dana Reyes
	email = dana@example.com
[init]
	defaultBranch = main
GITCONFIG

export HOME="$HOME_DIR"
export PATH="$HOME_DIR/.local/bin:$PATH"
export CAPSHELF_NO_SELF_UPDATE=1

# --- the data repo ---------------------------------------------------------

mkdir -p "$DATA/skills/security-review" "$DATA/skills/write-migration" \
  "$DATA/skills/release-notes" "$DATA/settings/strict-permissions"

cat > "$DATA/skills/security-review/SKILL.md" <<'SKILL'
---
name: security-review
description: Review a diff for common security defects before merge.
---

# Security review

Check every changed handler for:

- SQL built by string concatenation
- endpoints with no authorization check
- secrets read from source instead of the environment
SKILL

cat > "$DATA/skills/security-review/.capshelf.yml" <<'META'
tags: [security, review]
META

cat > "$DATA/skills/write-migration/SKILL.md" <<'SKILL'
---
name: write-migration
description: Write a reversible database migration with a matching down step.
---

# Write migration

Every migration ships with a down step that restores the previous schema.
SKILL

cat > "$DATA/skills/write-migration/.capshelf.yml" <<'META'
tags: [database]
META

cat > "$DATA/skills/release-notes/SKILL.md" <<'SKILL'
---
name: release-notes
description: Draft release notes from merged pull requests.
---

# Release notes

List each merged pull request as one line in the simple past.
SKILL

cat > "$DATA/skills/release-notes/.capshelf.yml" <<'META'
tags: [docs, release]
META

cat > "$DATA/settings/strict-permissions/settings.json" <<'JSON'
{
  "permissions": {
    "deny": ["Bash(rm -rf:*)", "Bash(git push --force:*)"]
  }
}
JSON

cat > "$DATA/settings/strict-permissions/.capshelf.yml" <<'META'
description: Deny the two shell commands no agent should run unattended.
tags: [safety]
META

git -C "$DATA" init -q
git -C "$DATA" remote add origin https://github.com/acme/agent-config
git -C "$DATA" add -A
git -C "$DATA" commit -q -m "initialize shared agent config"

# --- the two projects ------------------------------------------------------

for project in my-app other-app; do
  mkdir -p "$CODE/$project"
  git -C "$CODE/$project" init -q
  printf '# %s\n' "$project" > "$CODE/$project/README.md"
  git -C "$CODE/$project" add README.md
  git -C "$CODE/$project" commit -q -m "initial commit"
  (cd "$CODE/$project" && capshelf init --no-pick --data "$DATA" >/dev/null)
done

(cd "$CODE/my-app" && capshelf add security-review >/dev/null)
for project in my-app other-app; do
  git -C "$CODE/$project" add -A
  git -C "$CODE/$project" commit -q -m "connect capshelf"
done

# --- the environment the tape sources -------------------------------------

cat > "$SANDBOX/env.sh" <<ENV
export HOME=$HOME_DIR
export PATH=$HOME_DIR/.local/bin:\$PATH
export CAPSHELF_NO_SELF_UPDATE=1
export PS1='\\[\\e[38;5;110m\\]\\w\\[\\e[0m\\] \\[\\e[1;32m\\]\$\\[\\e[0m\\] '
cd "\$HOME"
ENV

echo "sandbox ready: $SANDBOX"
