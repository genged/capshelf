---
name: capshelf
description: Use the capshelf CLI to manage shared skills, settings, and MCP configs across multiple projects from a user-owned data repo.
---

# capshelf

This project uses **capshelf** to track shared Claude Code / Codex config (skills, settings fragments, MCP configs) pulled from a **data repo**. When the user asks to add, remove, discover, edit, or update shared config, use the `capshelf` CLI. **Do not hand-edit** `.capshelf/capshelf.json` or `.capshelf/capshelf.lock.json` — they are tool-managed.

Run project commands from the project root: the directory containing `.capshelf/capshelf.json`. Capshelf does not walk upward from subdirectories.

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

### 3. Evaluate before installing

`capshelf show <item>` prints the full description, `requires`, `conflicts-with`, and whether each relation is already installed. Use it before committing to an `add`.

### 4. Install

`capshelf add <item>`. If the output lists missing required items, install them with the exact `capshelf add <ref>` commands it prints. If `add` refuses with exit 3 because of a `conflicts-with` declaration, that is a curated incompatibility — surface the decision to the user (remove the conflicting item, or fix a stale declaration in the data repo); never work around it.

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

To change **metadata** (tags, description, `requires`/`conflicts-with`), edit `<data-repo>/<kind>/<name>/.capshelf.yml` and commit it in the data repo — no project `update` is needed afterwards; metadata is catalog data, never hashed into item content. **Commit the sidecar before returning to project work**: an uncommitted sidecar edit blocks `capshelf update` entirely (dirty data repo) and blocks `add` of that item.

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
| `init` / `set-data` / `set-upstream` / `data-path` | bind the project to a data repo |
| `ls` / `show` / `search` / `status` | inspect and discover (all support `--json`) |
| `add` / `rm` / `apply` / `update` / `revert` | converge the project on its locks |
| `share` / `move` / `promote` / `keep-local` | flow content and intent between project and data repo |
| `get-path` | print the editable path for an item |
| `self-update` | update the Homebrew-installed binary (not project pins) |

## Config fragments

Shared fragments merge into project config outputs: `settings/<name>/settings.json` → `.claude/settings.json`; `mcp/<name>/claude.json` → `.mcp.json`; `mcp/<name>/codex.toml` and `codex/config/<name>/config.toml` → `.codex/config.toml`. Outputs preserve unmanaged project-local values; capshelf refuses unmanaged scalar or shape collisions and names the paths involved.

Edit canonical source paths (from `get-path`), never the generated outputs, then `capshelf promote <fragment> -m "message"`. `share` for fragments requires `--from <file>` and `--to project` (plus `--target claude|codex` for MCP). Codex only loads `.codex/config.toml` in trusted projects; `status` warns non-fatally when the project appears untrusted.

## Coexistence

- **skills.sh** (`skills-lock.json` present): capshelf refuses or skips those skill paths instead of co-managing them; `status` groups them under `external/`.
- **Claude plugins**: read-only external state, reported by `status`, never edited.
- **Personal skills** (`~/.claude/skills/<name>`): shadow same-named project skills at runtime. Capshelf warns as `shadowed_by_personal_claude_skill` and `status --strict` fails until renamed or removed.
- Files or values in agent surfaces that are not locked contributions are project-local; capshelf preserves or ignores them.

## Safety rules

- **Never run `capshelf promote`** while the user has open PRs on other projects using that item, unless those projects are OK picking up the change on their next `update`.
- **Treat `add` conflict refusals (exit 3) as decisions for the user**, not obstacles. There is no force flag by design.
- **The lock is the source of truth** for what capshelf owns.
- **Use `capshelf self-update` only for Homebrew installs**; source installs update with `git pull && make install`. Set `CAPSHELF_NO_SELF_UPDATE=1` to suppress startup prompts.

## Troubleshooting

- `no data repo configured` — clone the declared `dataRepoUpstream` if one exists, then `capshelf set-data <path>`, or pass `--data <path>`, or set `$CAPSHELF_HOME`.
- `data repo at <path> is bound to the wrong upstream` — `capshelf set-data <correct-clone>` or intentionally change committed state with `capshelf set-upstream <url>`.
- `data repo has uncommitted metadata changes: <item>/.capshelf.yml` — commit the sidecar in the data repo; no item content is at risk.
- `git is required but was not found on PATH` — install Git or fix `PATH`.
- `not a git repository: <path>` — data repos must be git repos (`sourceCommit` provenance); `git init` it first.
- `⚠ <item>: invalid .capshelf.yml … — metadata ignored` — the item still works; fix the sidecar in the data repo when convenient.
- If `capshelf` itself is missing, point the user at the capshelf source repo and suggest `make install`.
