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

- **Data repo** (e.g. `~/code/capshelf-data/`, `~/code/work-skills/`) holds canonical versions of every shared item under `skills/`, `settings/`, `mcp/`, and `codex/config/`. It must be a git repo.
- **This project** pins the exact content hash of each item it uses in `.capshelf/capshelf.lock.json`.
- **Installed copies** live under `.agents/skills/<name>/` by default, with `.claude/skills/<name>` symlinks for Claude compatibility. Claude-only projects install directly under `.claude/skills/<name>/`.
- Claude custom commands are represented as skills. A skill at `.agents/skills/<name>/SKILL.md` creates the `/<name>` invocation surface through the `.claude/skills/<name>` symlink and can include frontmatter plus supporting files.

An update to the data repo does NOT automatically propagate — each project picks up changes when it runs `capshelf update`.

## Two kinds of items

- **system** items (lock prefix `system/`): bundled into the CLI binary itself. The `capshelf` skill (this file) is one. Installed automatically by `init`. Cannot be added/removed/promoted directly — to change, edit the CLI source and rebuild.
- **data** items (lock prefix `data/`): live in your data repo (`skills/`, `settings/`, `mcp/`, `codex/config/`). Added via `add` and removed via `rm`. Skills and fragments can be promoted back to the data repo; fragment promotion commits canonical source files, not generated outputs.

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
- `capshelf show <item>` — print metadata + content for one item (data or system). Use `--target claude|codex` for a specific MCP fragment target; `--json` can report both.
- `capshelf status [<item>] [--project] [--local] [--diff]` — drift / update report. Copy items report states such as `ok`, `update_available`, `drifted_local`, `missing_installed`, `missing_upstream`, and `kept-local`; fragments can also report `missing_output`, `source_dirty`, `output_drift`, or `source_dirty_and_output_drift`. `--diff` explains local drift against the locked content without changing files. `--strict` exits 4 if anything is neither ok nor kept-local, or if a strict runtime warning exists; Codex trust warnings are non-failing.
- `capshelf add <item> [--local]` — install a data item. Captures the data repo's current `lastTouchingCommit` as `sourceCommit` in the lock. `--local` records a skill in `.capshelf/local.json` and `.capshelf/local.lock.json`; local scope is rejected for fragments.
- `capshelf rm <item> [--local]` — remove a data item. Rejected (exit 3) for system items. Fragment removal reconciles generated outputs while preserving unmanaged local values.
- `capshelf get-path <item> [--output] [--target claude|codex]` — absolute path to edit. Fragment kinds return canonical data repo source paths by default; `--output` returns `.claude/settings.json`, `.mcp.json`, or `.codex/config.toml`.
- `capshelf apply [<item>] [--local] [--dry-run]` — reconcile files with lockfiles; data copy items via `git show <sourceCommit>`, fragments via generated outputs, system items from bundled content. `--dry-run` previews without writing files.
- `capshelf update [<item>...] [--local] [--dry-run]` — bump locked sha to data repo's current `lastTouchingCommit` (or to current binary's `cliVersion` for system items), then apply. Without args this updates project scope only; use `--local` for local-scope skills. `--dry-run` previews without writing files or the lock.
- `capshelf share <item> [--to local|project] [--from <path>] [--target claude|codex] [-m <msg>]` — adopt a not-yet-shared on-disk item into the data repo. Defaults to local scope for skills; fragments require `--from`, `--to project`, and `--target` for MCP.
- `capshelf move <item> --to <scope>` — move an already-tracked data item between local and project scope without changing data-repo content.
- `capshelf promote <item> [--local] [-m <msg>]` — push edits for an already-tracked data item up to the data repo and update only this project's lock. Fragment promotion commits canonical source files, not generated outputs. Rejected for system items.
- `capshelf keep-local <item> [--local] [--reason <text>]` — mark intentional project-local divergence for copy items. `--unset` clears it. Fragment kinds reject this because local values are preserved in generated outputs.
- `capshelf revert <item> [--local]` — discard local edits, restore from `sourceCommit` or bundled content.

## Config fragments

Shared fragments live in the data repo and merge into project config outputs:

- `settings/<name>/settings.json` -> `.claude/settings.json`
- `mcp/<name>/claude.json` -> `.mcp.json`
- `mcp/<name>/codex.toml` -> `.codex/config.toml`
- `codex/config/<name>/config.toml` -> `.codex/config.toml`

Use `capshelf add`, `apply`, `update`, `rm`, `revert`, and `status --diff` on
fragment refs just like skills. Outputs preserve unmanaged project-local
values. If a fragment would overwrite an unmanaged scalar or change a local
value's shape, capshelf refuses and names the output path, config path, and
fragment source path.

Use source paths for edits and output paths for inspection:

```
capshelf get-path settings/security
capshelf get-path mcp/github --target codex
capshelf get-path mcp/github --target codex --output
capshelf get-path codex-config/defaults --output
```

Use `share` with an explicit source file:

```
capshelf share settings/security --from ./settings.json --to project
capshelf share mcp/github --target claude --from ./claude-mcp.json --to project
capshelf share mcp/github --target codex --from ./codex-mcp.toml --to project
capshelf share codex-config/defaults --from ./config.toml --to project
```

To promote a fragment, edit the canonical source path returned by `get-path`,
then run `capshelf promote <fragment> -m "message"`. Do not edit generated
outputs and expect `promote` to infer one fragment from them.

Codex only loads `.codex/config.toml` in trusted projects. `status` reports a
non-failing warning when `codex` is installed and the project appears untrusted.

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
- **The lock is the source of truth** about which item files and generated config contributions are managed. Files or values in `.agents/`, `.claude/`, `.mcp.json`, or `.codex/config.toml` that are not locked contributions are project-local and capshelf preserves or ignores them.

## Troubleshooting

- `no data repo configured` — clone the declared `dataRepoUpstream` if one exists, then run `capshelf set-data <path>`, pass `--data <path>`, or set `$CAPSHELF_HOME=/path/to/data/repo`.
- `data repo at <path> is bound to the wrong upstream` — the local clone's `origin` does not match `dataRepoUpstream`; use `capshelf set-data <correct-clone>` or intentionally change committed state with `capshelf set-upstream <url>`.
- `git is required but was not found on PATH` — install Git or fix the shell `PATH`, then retry. Capshelf uses Git for data-repo provenance and diffs.
- `not a git repository: <path>` — the path you bound to isn't a git repo. `git init` it first; data repos must be git so that `sourceCommit` references work.
- CLI verbs exist in `--help` but behave unexpectedly — read the source at `~/code/capshelf-cli/src/commands/<verb>.ts`.
