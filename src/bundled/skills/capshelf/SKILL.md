---
name: capshelf
description: Use the capshelf CLI to manage shared skills, settings, and MCP configs across multiple projects from a user-owned data repo.
---

# capshelf

This project uses **capshelf** to track shared Claude Code / Codex config (skills, settings fragments, MCP configs) pulled from a **data repo**. The CLI is generic and has **no implicit default data repo**: every project must bind to one explicitly.

Resolution order: `--data <path>` flag > the project's gitignored `.capshelf/local.json` `dataRepo` field > `$CAPSHELF_HOME` env var. If none are set, every command fails with a clear message. The committed `.capshelf/capshelf.json` may declare `dataRepoUpstream`; capshelf verifies the local clone's `origin` against it before using the data repo.

Capshelf metadata lives under `.capshelf/`: committed `capshelf.json` and `capshelf.lock.json`, plus gitignored `local.json` and `local.lock.json` for the per-machine data repo path and local-only skill pins. By default, real skill directories live under `.agents/skills/<name>` and Claude sees them through per-skill symlinks at `.claude/skills/<name>`. Use `capshelf init --claude-only` only when a project should install directly under `.claude/`.

When the user asks to add, remove, edit, or update shared config, use the `capshelf` CLI. **Do not hand-edit** `.capshelf/capshelf.json` or `.capshelf/capshelf.lock.json` — they are tool-managed.

## How it works

- **Data repo** (e.g. `~/code/capshelf-data/`, `~/code/work-skills/`) holds canonical versions of every shared item under `skills/`, `settings/`, `mcp/`. It must be a git repo.
- **This project** pins the exact content hash of each item it uses in `.capshelf/capshelf.lock.json`.
- **Installed copies** live under `.agents/skills/<name>/` by default, with `.claude/skills/<name>` symlinks for Claude compatibility. Claude-only projects install directly under `.claude/skills/<name>/`.
- Claude custom commands are represented as skills. A skill at `.agents/skills/<name>/SKILL.md` creates the `/<name>` invocation surface through the `.claude/skills/<name>` symlink and can include frontmatter plus supporting files.

An update to the data repo does NOT automatically propagate — each project picks up changes when it runs `capshelf update`.

## Two kinds of items

- **system** items (lock prefix `system/`): bundled into the CLI binary itself. The `capshelf` skill (this file) is one. Installed automatically by `init`. Cannot be added/removed/promoted directly — to change, edit the CLI source and rebuild.
- **data** items (lock prefix `data/`): live in your data repo (`skills/`, `settings/`, `mcp/`). Added via `add` and removed via `rm`. Skills can be promoted back to the data repo; settings fragments are edited in the data repo directly for now.

## Available commands

Always check current surface with:

```
capshelf --help
```

Most item arguments accept either a bare unique name (`hello`) or an explicit kind/name ref (`skills/hello`). Use `skills/<name>` when a bare name might be ambiguous.

Mutating commands only touch item files that are tracked in `.capshelf/capshelf.lock.json` or `.capshelf/local.lock.json`. `capshelf add` refuses to overwrite an existing untracked target, `capshelf init` refuses to overwrite an existing untracked system target, and `capshelf rm` deletes only locked data items. For a local-only skill that should become shared, use `capshelf share skills/<name>` to keep it local here or `capshelf share skills/<name> --to project` to commit it to project policy.

### Available commands

- `capshelf --data <path>` — global flag, overrides the data repo for any command.
- `capshelf init [--data <path>] [--upstream <url>] [--no-upstream] [--claude-only]` — bind this project to a data repo and install all bundled system items. Writes the path to `.capshelf/local.json`; writes only portable metadata to `.capshelf/capshelf.json`.
- `capshelf set-data <path>` — write or replace this machine's `.capshelf/local.json` binding after verifying git, upstream, and current lock entries.
- `capshelf set-upstream <url>` — set the committed `dataRepoUpstream` URL in `.capshelf/capshelf.json`.
- `capshelf ls` — list available items grouped as `system/` and `data/`. Add `--here` to list installed items in this project, `--kind skills` to filter, `--json` for machine output.
- `capshelf show <item>` — print metadata + content for one item (data or system). `--no-content` skips the body; `--json` prints just metadata.
- `capshelf status [<item>] [--project] [--local] [--diff]` — drift / update report. Each item is one of: `ok`, `update_available`, `drifted_local`, `drifted_and_update`, `missing_installed`, `missing_upstream`, `upstream_dirty`, `drifted_and_upstream_dirty`, `kept-local`. `--diff` explains local drift against the locked content without changing files. `--strict` exits 4 if anything is neither ok nor kept-local, or if a personal Claude skill shadows a project-managed skill; `--json` for machine output.
- `capshelf add <item> [--local]` — install a data item. Captures the data repo's current `lastTouchingCommit` as `sourceCommit` in the lock. `--local` records a skill in `.capshelf/local.json` and `.capshelf/local.lock.json`.
- `capshelf rm <item> [--local]` — remove a data item. Rejected (exit 3) for system items.
- `capshelf get-path <item>` — absolute path to an installed item so you can edit it.
- `capshelf apply [<item>] [--local] [--dry-run]` — reconcile files with lockfiles; data items via `git show <sourceCommit>`, system items from bundled content. `--dry-run` previews without writing files.
- `capshelf update [<item>...] [--local] [--dry-run]` — bump locked sha to data repo's current `lastTouchingCommit` (or to current binary's `cliVersion` for system items), then apply. Without args this updates project scope only; use `--local` for local scope. `--dry-run` previews without writing files or the lock.
- `capshelf share <item> [--to local|project] [-m <msg>]` — adopt a not-yet-shared on-disk item into the data repo. Defaults to local scope for skills; use `--to project` for committed project policy.
- `capshelf move <item> --to <scope>` — move an already-tracked data item between local and project scope without changing data-repo content.
- `capshelf promote <item> [--local] [-m <msg>]` — push edits for an already-tracked data item up to the data repo and update only this project's lock. Rejected for system items.
- `capshelf keep-local <item> [--local] [--reason <text>]` — mark intentional project-local divergence. `--unset` clears it.
- `capshelf revert <item> [--local]` — discard local edits, restore from `sourceCommit` or bundled content.

## Settings fragments

Shared Claude settings live in the data repo as `settings/<name>/settings.json`.
`capshelf add settings/<name>` and `capshelf update settings/<name>` overlay
the managed contribution into `.claude/settings.json` while preserving local
project settings that are not managed by that fragment. Use `--dry-run` before
`update` when reviewing security setting changes.

When a settings fragment changes in the data repo, run
`capshelf status settings/<name>` to see `update_available`, then
`capshelf update settings/<name>` in projects that should accept the change.
`capshelf share settings/<name>`, `capshelf move settings/<name>`, and
`capshelf promote settings/<name>` are intentionally rejected until fragment
promotion is implemented.

If `status` reports `settings-output-drift`, inspect it with:

```
capshelf status settings/<name> --diff
```

The diff is for the merged `.claude/settings.json` output, because all settings
fragments contribute to that one file. When that shared output is reconciled,
`apply` and `update` report the write as `data/settings/(merged)` rather than
as one specific fragment.

## The edit loop

When the user asks you to improve a shared (data) skill:

1. Run `capshelf get-path <skill-name>` to get the absolute path.
2. Edit the file with your Edit/Write tools.
3. Run `capshelf status <skill-name>` — should report `drifted_local`.
4. Decide with the user:
   - `capshelf promote <skill-name> -m "why"` — push to the data repo. Other projects will see `update available` next time they check status, but won't auto-change.
   - `capshelf keep-local <skill-name> --reason "why"` — intentional project-specific divergence.
   - `capshelf revert <skill-name>` — discard the edit, restore from the recorded `sourceCommit`.

For system items (e.g. this `capshelf` skill), the edit loop doesn't apply — to change them, edit the source in `~/code/capshelf-cli/src/bundled/` and rebuild the CLI.

## Adopting a local skill

```
capshelf share skills/<name> --to project -m "initial <name> skill"
```

Use this after creating `.agents/skills/<name>/SKILL.md` locally in the default layout, or `.claude/skills/<name>/SKILL.md` in a Claude-only project. It creates the matching data-repo skill, commits it, and starts tracking it in this project. Omit `--to project` to keep the item tracked as clone-local here while still publishing it to the data repo for other projects to add later.

For existing Claude projects in the default layout, this also adopts a real
`.claude/skills/<name>/` directory when `.agents/skills/<name>/` does not
already exist. After the data-repo commit succeeds, capshelf moves the
managed project copy under `.agents/skills/<name>/` and replaces
`.claude/skills/<name>` with the normal compatibility symlink.

## Coexisting with skills.sh

If a project has `skills-lock.json`, capshelf treats those skills as managed by `skills.sh`. `add`, `share`, `rm`, `apply`, `update`, `revert`, and `promote` refuse or skip those skill paths instead of co-managing them. `status` shows them under an `external/` group and `--strict` ignores them. This also covers skills.sh's Codex layout, where each `.claude/skills/<name>` entry is a symlink to `.agents/skills/<name>`.

Claude also loads personal skills from `~/.claude/skills/<name>`. If that name
matches a project-managed skill, Claude will load the personal skill first.
Capshelf warns as `shadowed_by_personal_claude_skill` from `init`, `add`,
`apply`, `update`, `revert`, `promote`, and `status`; `status` lists it under
`external/  (Personal Claude)`, and `status --strict` fails until the personal
skill is removed or renamed.

## Safety rules

- **Never run `capshelf promote`** while the user has open PRs on other projects that use that item, unless those projects are OK picking up the change on their next `update`.
- **Run `capshelf status` at session start** to see drift and available updates before making changes.
- **If `capshelf` command is missing or fails**, the CLI may not be installed. Point the user at `~/code/capshelf-cli/` and suggest `make install`.
- **The lock is the source of truth** about which item files are managed. Files in `.agents/` or `.claude/` that are NOT listed in the lock are project-local and capshelf ignores them.

## Troubleshooting

- `no data repo configured` — clone the declared `dataRepoUpstream` if one exists, then run `capshelf set-data <path>`, pass `--data <path>`, or set `$CAPSHELF_HOME=/path/to/data/repo`.
- `data repo at <path> is bound to the wrong upstream` — the local clone's `origin` does not match `dataRepoUpstream`; use `capshelf set-data <correct-clone>` or intentionally change committed state with `capshelf set-upstream <url>`.
- `git is required but was not found on PATH` — install Git or fix the shell `PATH`, then retry. Capshelf uses Git for data-repo provenance and diffs.
- `not a git repository: <path>` — the path you bound to isn't a git repo. `git init` it first; data repos must be git so that `sourceCommit` references work.
- CLI verbs exist in `--help` but behave unexpectedly — read the source at `~/code/capshelf-cli/src/commands/<verb>.ts`.
