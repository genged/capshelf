---
name: capshelf
description: Use the capshelf CLI to manage shared skills, settings, and MCP configs across multiple projects from a user-owned data repo.
---

# capshelf

This project uses **capshelf** to track shared Claude Code / Codex config (skills, settings fragments, MCP configs) pulled from a **data repo**. When the user asks to add, remove, discover, edit, or update shared config, use the `capshelf` CLI. **Do not hand-edit** `.capshelf/capshelf.json` or `.capshelf/capshelf.lock.json` — they are tool-managed.

Run project commands from anywhere inside a capshelf project — the directory containing `.capshelf/capshelf.json`, or any subdirectory of it (capshelf walks upward to find the root, like git). `init` acts on the current directory, not a discovered parent.

## The agent decision loop

Work the shelf in this order instead of pattern-matching on bare item names:

### 1. Survey the project

Run `capshelf status` at session start to see drift and available updates before changing anything. `capshelf ls --here` lists what is already installed (with descriptions and `#tags` when the data repo declares them).

### 2. Discover on the shelf

Reach for `capshelf search <task words>` first — it matches names, tags, descriptions, and item content across the bound data repo plus bundled system items, ranked by relevance:

```
capshelf search "sql injection"
capshelf search security --json
```

Zero matches exit 0 — an empty answer is a valid answer, not an error. To browse instead, use `capshelf ls --tag <tag>` (repeatable, AND) or `ls --kind <kind>`. Descriptions and tags are the selection signal.

Results with a `bundles/` prefix are **bundles** — curated item sets. Prefer them when setting up a project: `capshelf show bundles/<name>` to preview members and install state, then `capshelf add bundles/<name>` to expand. Expansion is traceless (members become ordinary independent items); the `bundle` field in `add --json` is the only echo and is what belongs in a commit message.

### 3. Evaluate before installing

`capshelf show <item>` prints the full description, `requires`, `conflicts-with`, and whether each relation is already installed. Use it before committing to an `add`.

### 4. Install

`capshelf add <item>`. If the output lists missing required items, install them with the exact `capshelf add <ref>` commands it prints. If `add` refuses with exit 3 because of a `conflicts-with` declaration, that is a curated incompatibility — surface the decision to the user (remove the conflicting item, or fix a stale declaration in the data repo); never work around it. A bundle preflight refusal (exit 3) is the same kind of decision: nothing was installed and the per-member report says why — surface it, don't install members one by one to route around it.

### 5. Verify

`capshelf status --strict` — exit 0 means the project has converged on its locks.

### 6. Edit / promote loop

When the user asks you to improve a shared (data) item:

1. `capshelf get-path <item>` for the absolute editable path (fragments return canonical data-repo source files; `--output` returns generated outputs for inspection only).
2. Edit with your Edit/Write tools.
3. `capshelf status <item>` — should report `drifted_local` (or `source_dirty` for fragments).
4. Decide with the user:
   - `capshelf promote <item> -m "why"` — push to the data repo. Other projects see `update available` next time they check; nothing auto-changes.
   - `capshelf keep-local <item> --reason "why"` — intentional project-specific divergence (copy items only).
   - `capshelf revert <item>` — discard the edit, restore from the recorded `sourceCommit`.

If `promote` fails with "changed in the data repo since this project last updated" (exit 3), a teammate's newer version is upstream. **Do not retry with `--stale-ok` on your own** — show the user the upstream diff (`capshelf status <item> --diff` plus the scoped `git log` from the error message) and let them choose between `capshelf update <item>`-then-redo-the-edit and an intentional `capshelf promote <item> --stale-ok` overwrite. A promote that reports `already-upstream` means someone already promoted identical content; the lock was re-pinned and nothing more is needed.

To change **metadata** (tags, description, `requires`/`conflicts-with`), edit `<data-repo>/<kind>/<name>/.capshelf.yml` and commit it in the data repo — no project `update` is needed afterwards; metadata is catalog data, never hashed into item content. **Commit the sidecar before returning to project work**: an uncommitted sidecar edit blocks `capshelf update` entirely (dirty data repo) and blocks `add` of that item.

For a skill's **description**, prefer SKILL.md frontmatter — it doubles as the catalog fallback. Know the trade-off when choosing where to edit: a frontmatter edit is content drift (shipped to Claude, hashed — consuming projects see `update available`), while a sidecar edit is drift-free. Add a sidecar `description` only when the catalog blurb should differ from the frontmatter's invocation-trigger phrasing, or when tuning copy must not ship a content change; sidecar wins when both exist. Fragment items (settings/mcp/codex-config) have no frontmatter — the sidecar is their only description source.

For system items (e.g. this `capshelf` skill), the edit loop doesn't apply — to change them, edit the CLI source under `src/bundled/` and rebuild.

## How it works

- **Data repo** (e.g. `~/code/work-skills/`) holds canonical versions of every shared item under `skills/`, `settings/`, `mcp/`, and `codex/config/`. It must be a git repo. Resolution order: `--data <path>` flag > gitignored `.capshelf/local.json` > `$CAPSHELF_HOME`. There is no implicit default.
- **This project** pins the exact content hash + source commit of each item in `.capshelf/capshelf.lock.json` (clone-local pins in gitignored `.capshelf/local.lock.json`). Data-repo updates do NOT propagate until this project runs `capshelf update`.
- **Installed copies** live under `.agents/skills/<name>/` by default with `.claude/skills/<name>` symlinks (Claude-only projects install directly under `.claude/skills/<name>/`). Claude custom commands are modeled as skills.
- **Item metadata** (optional `<item>/.capshelf.yml` in the data repo: `description`, `tags`, `requires`, `conflicts-with`) feeds `ls`/`show`/`search` and `add` enforcement. It is never copied into projects and never affects drift.

## Two kinds of items

- **system** (lock prefix `system/`): bundled into the CLI binary, installed by `init`, read-only from a project's perspective.
- **data** (lock prefix `data/`): live in your data repo. Added via `add`, removed via `rm`, adopted via `share`, pushed back via `promote`.

Mutating commands only touch files tracked in the lockfiles: `add` refuses to overwrite an existing untracked target, and `rm` deletes only locked data items. For a local-only skill that should become shared, use `capshelf share skills/<name>` (local scope here) or `capshelf share skills/<name> --to project` (committed project policy).

## Command reference

Always check the current surface with `capshelf --help` and `capshelf <verb> --help`. Most item arguments accept a bare unique name (`hello`) or a kind-qualified ref (`skills/hello`).

| verb | purpose |
|---|---|
| `init` / `data bind` / `data upstream` / `data path` | bind the project to a data repo (the data-repo verbs live under `capshelf data <sub>`; old `set-data`/`set-upstream`/`data-path`/`sync-data` still work as aliases) |
| `ls` / `show` / `search` / `status` | inspect and discover (all support `--json`) |
| `add` / `rm` / `apply` / `update` / `revert` | converge the project on its locks |
| `share` / `move` / `promote` / `keep-local` | flow content and intent between project and data repo |
| `data sync [--json]` | explicitly fetch the bound data repo's origin and fast-forward when safe; the **only** capshelf command that touches the network besides the `init` bootstrap clone and `self-update`. Run it when the user asks to pick up teammates' changes, then `capshelf status` to see `update_available` |
| `get-path` | print the editable path for an item |
| `self-update` | update the Homebrew-installed binary (not project pins) |

## Proposing changes upstream (review required, or no direct push access)

Capshelf never pushes and never creates branches — branch in the data repo with ordinary git, let `promote` commit on the branch, then push and open a PR with `gh`:

```bash
DATA=$(capshelf data-path)            # fallback: jq -r .dataRepo .capshelf/local.json
BRANCH=$(git -C "$DATA" symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')   # the repo's default branch
capshelf sync-data
git -C "$DATA" switch -c propose/<topic> "origin/$BRANCH"
# edit the installed item in the project, then:
capshelf promote <item> -m "why"
git -C "$DATA" push -u origin propose/<topic>
gh pr create --repo <owner/data-repo> --head propose/<topic> --title "..." --body "..."
```

After the PR merges, re-pin the lock to the merged history (until then the lock pins the proposal-branch commit, which squash/rebase merges orphan):

```bash
git -C "$DATA" switch "$BRANCH"
capshelf sync-data
capshelf update <item>
```

Fork variant (read-only consumers): `gh repo fork <owner/data-repo> --clone=false`, `git -C "$DATA" remote add fork <fork-url>`, branch and promote as above, then `git -C "$DATA" push -u fork propose/<topic>` and `gh pr create --repo <owner/data-repo> --head <user>:propose/<topic>`. Capshelf's upstream verification only checks `origin`, so the extra `fork` remote is safe and `sync-data` keeps pulling from `origin`.

## Config fragments

Shared fragments merge into project config outputs: `settings/<name>/settings.json` → `.claude/settings.json`; `mcp/<name>/claude.json` → `.mcp.json`; `mcp/<name>/codex.toml` and `codex/config/<name>/config.toml` → `.codex/config.toml`. Outputs preserve unmanaged project-local values; capshelf refuses unmanaged scalar or shape collisions and names the paths involved.

Edit canonical source paths (from `get-path`), never the generated outputs, then `capshelf promote <fragment> -m "message"`. `share` for fragments always lands in project scope (`--to project` is the default). To share an existing MCP server, `capshelf share mcp/<server>` with no flags is the common case: the pick defaults to the item name and capshelf adopts the server from every output that contains it unmanaged (`.mcp.json` and/or `.codex/config.toml`), in one commit. Other cases use:

- `--from <file>` — an explicit fragment source file (for mcp, requires `--target claude|codex`).
- `--pick <path>` (repeatable) — extract unmanaged values straight from the generated output, no separate file needed. **Prefer this when the values already live in `.claude/settings.json`, `.mcp.json`, or `.codex/config.toml`.** Settings/codex-config picks are dot paths (`--pick permissions.allow`) and are always required for those kinds; mcp picks accept bare server names (`--pick github`, only needed when the item name differs from the server name). Picking a value managed by another fragment fails and names the owner; the output file is unchanged — picked values just become managed by the new fragment.
- `--target claude|codex` — restrict an mcp share to one output instead of every matching one.

```bash
capshelf share mcp/github
capshelf share settings/permissions --pick permissions.allow
```

Codex only loads `.codex/config.toml` in trusted projects; `status` warns non-fatally when the project appears untrusted.

## Coexistence

- **skills.sh** (`skills-lock.json` present): capshelf refuses or skips those skill paths instead of co-managing them; `status` groups them under `external/`.
- **Claude plugins**: read-only external state, reported by `status`, never edited.
- **Personal skills** (`~/.claude/skills/<name>`): shadow same-named project skills at runtime. Capshelf warns as `shadowed_by_personal_claude_skill` and `status --strict` fails until renamed or removed.
- Files or values in agent surfaces that are not locked contributions are project-local; capshelf preserves or ignores them.

## Safety rules

- **Never run `capshelf promote`** while the user has open PRs on other projects using that item, unless those projects are OK picking up the change on their next `update`.
- **Treat `add` conflict refusals (exit 3) as decisions for the user**, not obstacles. There is no force flag by design.
- **Never pass `promote --stale-ok` without explicit user direction** — it intentionally overwrites a teammate's newer upstream version.
- **The lock is the source of truth** for what capshelf owns.
- **Use `capshelf self-update` only for Homebrew installs**; source installs update with `git pull && make install`. Set `CAPSHELF_NO_SELF_UPDATE=1` to suppress startup prompts.

## Troubleshooting

- `no data repo configured` — clone the declared `dataRepoUpstream` if one exists, then `capshelf set-data <path>`, or pass `--data <path>`, or set `$CAPSHELF_HOME`.
- `could not determine a portable data repo upstream` — configure the data repo's `origin` before `capshelf init`, or pass `--no-upstream` only for an intentionally non-portable local project.
- `data repo at <path> is bound to the wrong upstream` — `capshelf set-data <correct-clone>` or intentionally change committed state with `capshelf set-upstream <url>`.
- `data repo has uncommitted metadata changes: <item>/.capshelf.yml` — commit the sidecar in the data repo; no item content is at risk.
- `missing_source_commit` in `status` — the locked `sourceCommit` is unreachable in the data repo (unpushed in another clone, or squash-orphaned after a merged proposal). Fix with `capshelf sync-data && capshelf update <item>`; if the commit only exists in another clone, push or fetch that clone first.
- `git is required but was not found on PATH` — install Git or fix `PATH`.
- `not a git repository: <path>` — data repos must be git repos (`sourceCommit` provenance); `git init` it first.
- `⚠ <item>: invalid .capshelf.yml … — metadata ignored` — the item still works; fix the sidecar in the data repo when convenient.
- If `capshelf` itself is missing, point the user at the capshelf source repo and suggest `make install`.
