# CLI surface

## Design principles

1. **Agent-first.** The primary user is a coding agent, not a human. Every command has `--json` (machine output) and `--yes` (no prompts) modes. Stable exit codes.
2. **Verbs over flags.** `add`, `rm`, `share`, `move`, and `promote` are first-class. You rarely type a path.
3. **Kind inference.** Names are unique across kinds in master (`doctor` enforces this). `capshelf add security-review` Just Works. Disambiguate with `skills/security-review` if needed.
4. **Read-only by default for foreign projects.** `update` in project A cannot affect project B. `share` and `promote` write only the bound data repo and the calling project; B only changes when it runs `update` or `add`.
5. **No silent writes.** Every command shows what it touched. `--quiet` exists for scripts.

Claude custom commands are modeled as skills. capshelf does not manage `.claude/commands/`; create `skills/<name>/SKILL.md` for a reusable `/<name>` entry.

Capshelf metadata lives under `.capshelf/` at the project root. `.capshelf/capshelf.json` and `.capshelf/capshelf.lock.json` are committed; `.capshelf/local.json` and `.capshelf/local.lock.json` are gitignored by `.capshelf/.gitignore` and store the per-machine data repo path plus local-only item intent and pins. By default, skills are installed as real directories under `.agents/skills/<name>` and exposed to Claude through per-skill symlinks at `.claude/skills/<name>`. Use `capshelf init --claude-only` only when a project should install directly under `.claude/` without `.agents` symlinks.

Claude also loads personal skills from `~/.claude/skills/<name>`. If a personal
skill has the same name as a project-managed skill, Claude will use the personal
skill first. Capshelf does not manage the personal copy, but `init`, `add`,
`apply`, `update`, `revert`, `promote`, and `status` warn with
`shadowed_by_personal_claude_skill`. `status` also lists the shadowing skill in
`external/  (Personal Claude)`, and `status --strict` exits 4 while the shadow
exists.

Most item arguments accept either a bare unique name (`hello`) or an explicit kind/name ref (`skills/hello`). Lock keys such as `data/skills/hello` are internal and are not accepted as normal item refs.

Mutating commands only touch item files that are tracked in `.capshelf/capshelf.lock.json` or `.capshelf/local.lock.json`. `add` refuses to overwrite an existing untracked target, `init` refuses to overwrite an existing untracked system target, and `rm` deletes only locked data items. For a local-only skill that should become shared, use `share <item>` to keep it local here or `share <item> --to project` to commit it to project policy.

## Command surface

Current status shown as `[M?]` milestone number. See `milestones.md`.

| verb | purpose | status |
|---|---|---|
| `init` | scaffold a new project (manifest + lock, install bundled system items, bind data repo) | M1 ✓ (data binding in M3) |
| `set-data <path>` | bind this machine to the project's data repo clone via `.capshelf/local.json` | M4 ✓ |
| `set-upstream <url>` | write the committed `dataRepoUpstream` URL in `.capshelf/capshelf.json` | M4 ✓ |
| `ls` | list items in master (default) or in this project (`--here`) | M2 ✓ |
| `show <item>` | print metadata + content for one item | M2 ✓ |
| `status [<item>]` | drift / update report for this project; `--project` and `--local` filter scopes; `--diff` explains local drift | M2 ✓ |
| `add <item>` | install an item from the bound data repo; `--local` installs a clone-local skill | M2 ✓ |
| `rm <item>` | remove from this project; `--local` removes clone-local skills | M2 ✓ |
| `get-path <item>` | print absolute path to the installed item (for settings, the merged `.claude/settings.json`) | M4 ✓ |
| `apply [<item>]` | reconcile project and local files with lockfiles (data items via `git show <sourceCommit>`; system items from bundled content); supports `--local` and `--dry-run` | M4 ✓ |
| `update [<item>...]` | bump project pins by default; `--local` or an explicit local-only ref updates local pins; supports `--dry-run` | M4 ✓ |
| `share <item>` | adopt a not-yet-shared on-disk item into the data repo; defaults to `--to local`, supports `--to project` | M5 ✓ |
| `move <item> --to <scope>` | move an already-tracked data item between local and project scope without changing data-repo content | M5 ✓ |
| `promote <item>` | push edits for an already-tracked data item to the data repo; `--local` selects local-scope skills; settings fragments are rejected for now | M4 ✓ |
| `keep-local <item>` | mark drifted item as intentional project-local divergence; supports `--local` | M4 ✓ |
| `revert <item>` | discard local edits, restore locked version; supports `--local` | M4 ✓ |
| `validate <name>` | lint an item (frontmatter, structure, broken refs) | M6 |
| `diff <name> [<ref>]` | show what would change on apply/update/promote | M6 |
| `doctor` | audit integrity (requires/conflicts, lockfile drift, uniqueness, system/data namespace collisions) | M6 |
| `journal` | recent activity (who/when/what) | M6 |
| `search` | fuzzy-find by name/tag across the data repo | M6 |
| `bundle` | apply / save / list bundles | M6 |

## Common Flags

- `--data <path>` — global override for the data repo (otherwise resolved from `.capshelf/local.json`, then `$CAPSHELF_HOME`, then fail)
- `--json` — per-command structured output where supported
- `--dry-run` — supported by `apply` and `update`; previews planned writes without changing files or lock state
- `--diff` — supported by `status`; shows local drift against the locked content without changing files
- `--yes`/`-y` — planned for future commands that would otherwise prompt
- `--quiet`/`-q` and `--cwd <path>` — planned, not currently implemented

## Init Layout

```
capshelf init --data ../capshelf-data                # default: real .agents/ skills + .claude/ symlinks
capshelf init --claude-only --data ../capshelf-data  # real .claude/ skills only
capshelf init --data ../capshelf-data --upstream https://github.com/acme/capshelf-data
capshelf init --data ../capshelf-data --no-upstream  # omit dataRepoUpstream even if origin exists
```

The selected layout is stored in `.capshelf/capshelf.json` as `installMode`. The data
repo path is stored in gitignored `.capshelf/local.json`. If the data repo has an
`origin` remote, `init` writes its normalized URL to `dataRepoUpstream` unless
`--no-upstream` is used; `--upstream <url>` overrides auto-detection.

## Data repo binding

For a cloned project whose committed manifest declares an upstream:

```bash
git clone https://github.com/acme/capshelf-data ~/code/capshelf-data
capshelf set-data ~/code/capshelf-data
capshelf apply
```

`set-data` verifies the path is a git repo, checks the clone's `origin` against
`dataRepoUpstream` when present, verifies existing data lock entries can be read
from the clone, writes `.capshelf/local.json`, and ensures
`.capshelf/.gitignore` contains that file.

Use `capshelf set-upstream <url>` to add or change the committed upstream URL.
The URL is normalized before writing. Unsupported URL shapes are rejected.

Legacy projects with `dataRepo` in `.capshelf/capshelf.json` or root
`capshelf.json` fail normal commands with:

```text
<manifest-path> uses the legacy dataRepo field.
  fix it manually:
    1. remove dataRepo from <manifest-path>.
    2. point capshelf at that path:
         capshelf set-data <path-from-dataRepo>
    3. optionally declare the upstream (commits to .capshelf/capshelf.json):
         capshelf set-upstream <origin-url>
```

`capshelf migrate` and `capshelf migrate-data-repo-config` are no longer
registered.

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | generic error (missing args, bad config, I/O) |
| 2 | item not found in data repo |
| 3 | conflict (`conflicts-with`, promote would clobber, operation rejected on a system item, or path is managed by skills.sh) |
| 4 | drift detected (for `status --strict`) or upstream verification failed |
| 5 | requires not met |
| 6 | reserved for data repo not configured |
| 7 | required dependency missing (`git` not found on `PATH`) |

Missing binding with an upstream declared:

```text
no data repo configured for this project.
upstream (per .capshelf/capshelf.json): https://github.com/acme/capshelf-data

  1. clone it somewhere you control:
       git clone https://github.com/acme/capshelf-data <path>
  2. point capshelf at it:
       capshelf set-data <path>
  3. retry:
       capshelf apply
```

Upstream mismatch:

```text
data repo at <path> is bound to the wrong upstream.

  .capshelf/capshelf.json declares: <canonical-upstream>
  local clone origin:     <canonical-origin>

  fix by one of:
    - point capshelf at a clone of the declared upstream:
        capshelf set-data <path-to-correct-clone>
    - change the project's declared upstream (commits to .capshelf/capshelf.json):
        capshelf set-upstream <new-url>
```

## The edit loop (M4)

The core agent-driven flow. Works on data items only — system items are read-only from the project's perspective.

```
 agent: capshelf get-path security-review
   ← { path: ".agents/skills/security-review/SKILL.md",
        locked_sha: "9f2c1e", source_commit: "abc123",
        data_repo_sha: "9f2c1e" }

 agent: Edit tool on that file

 agent: capshelf status security-review
   ← { state: "drifted_local", locked_sha: "9f2c1e",
        current_sha: "fa17b2", data_repo_sha: "9f2c1e",
        diff_summary: "+12 -3" }

 agent (or user) chooses:
   capshelf promote security-review -m "add SQLi check"
   capshelf keep-local security-review --reason "proj-A uses stricter rules"
   capshelf revert security-review     # uses sourceCommit + git show to restore
```

## Adopting a local skill (M5)

```
mkdir -p .agents/skills/write-migration .claude/skills
ln -s ../../.agents/skills/write-migration .claude/skills/write-migration
$EDITOR .agents/skills/write-migration/SKILL.md

capshelf share skills/write-migration --to project -m "initial write-migration skill"
  → creates <data-repo>/skills/write-migration/
  → commits it in the data repo
  → tracks it in this project's manifest + lock
```

Without `--to project`, `share` tracks the skill in local scope after committing
it to the data repo, so other clones can add it later without making this
project's committed policy require it. For existing Claude projects in the
default layout, `share` can also adopt a real `.claude/skills/<name>/` directory
when `.agents/skills/<name>/` does not already exist. After the data-repo commit
succeeds, capshelf normalizes the project to the default layout: real files under
`.agents/skills/<name>/` and a `.claude/skills/<name>` symlink.

`promote --create` still works for one minor release, but prints a deprecation
hint. `promote --local --to-project` has been removed; use `share` for adoption
and `move --to <scope>` for scope changes.

## Coexisting with skills.sh

If a project has `skills-lock.json`, capshelf treats those skills as managed by `skills.sh`. `add`, `share`, `rm`, `apply`, `update`, `revert`, and `promote` refuse or skip those skill paths instead of co-managing them. `status` shows them under an `external/` group and `--strict` ignores them. This also covers skills.sh's Codex layout, where each `.claude/skills/<name>` entry is a symlink to `.agents/skills/<name>`.

## Coexisting with Claude plugins

Capshelf reads Claude Code `enabledPlugins` entries from managed settings,
`~/.claude/settings.json`, `.claude/settings.json`, and
`.claude/settings.local.json`. `status` reports them under
`external/  (Claude plugins)` with scope and enabled/disabled state. These are
read-only external items: capshelf does not edit Claude plugin settings or
mutate `~/.claude/plugins/cache`.

## Install

Local install (current):

```
make install        # builds binary, copies to ~/.local/bin/capshelf
```

Dev loop:

```
bun run src/cli.ts <verb> [args]    # run source directly, no build
```

Later (M8): Homebrew tap + prebuilt binaries via goreleaser-equivalent.

## Why no MCP server in v1

An MCP server would let agents call `capshelf_add`, `capshelf_status`, etc. as first-class tools without shelling out. It's a better interface long-term. But:

- The bootstrap skill (bundled into the CLI binary, installed by every `init`) tells any agent reading it how to use the CLI — that's enough for v1.
- Agents already have `Bash` tool, so `bash(capshelf status)` works today.
- Adding MCP is straightforward later — same operations, different transport. Defer until the CLI is stable.

## What a human still does

1. Approve a `promote` when the agent surfaces it.
2. Glance at `capshelf status` when starting a project.
3. Choose a bundle / architecture for a new project.

Everything else — search, edit, validate, promote, reconcile — is the agent's job.

## Settings fragments

Claude settings fragments live in the data repo as `settings/<name>/settings.json`.
Adding one records a lock entry and overlays the managed contribution into
`.claude/settings.json` without discarding existing project-local settings:

```bash
capshelf add settings/security-base
capshelf update settings/security-base --dry-run
capshelf update settings/security-base
```

When a fragment changes in the data repo, `status settings/<name>` reports
`update_available`. `update` removes the old managed contribution, keeps local
additions in `.claude/settings.json`, and applies the newly locked fragment.
`share`, `move`, and `promote` do not handle settings fragments yet; edit
`settings/<name>/settings.json` in the data repo directly, commit it there, then
run `capshelf update settings/<name>` in each project that should pick it up.

To inspect local settings drift:

```bash
capshelf status settings/security-base --diff
```

All settings fragments share one output file, so a settings diff explains the
merged `.claude/settings.json` output rather than only one fragment directory.
When that shared output is reconciled, `apply` and `update` report it as
`data/settings/(merged)` instead of attributing the write to one fragment.
