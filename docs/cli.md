# CLI surface

## Design principles

1. **Agent-first.** The primary user is a coding agent, not a human. Commands expose `--json` where structured output is useful. Stable exit codes.
2. **Verbs over flags.** `add`, `rm`, `share`, `move`, and `promote` are first-class. You rarely type a path.
3. **Kind inference.** Bare names work when they resolve to one item. Disambiguate with `skills/security-review` if needed.
4. **Read-only by default for foreign projects.** `update` in project A cannot affect project B. `share` and `promote` write only the bound data repo and the calling project; B only changes when it runs `update` or `add`.
5. **No silent writes.** Mutating commands show what they touched; use `--json` where scripts need structured output.

Claude custom commands are modeled as skills. capshelf does not manage `.claude/commands/`; create `skills/<name>/SKILL.md` for a reusable `/<name>` entry.

Capshelf metadata lives under `.capshelf/` at the project root. `.capshelf/capshelf.json` and `.capshelf/capshelf.lock.json` are committed; `.capshelf/local.json` and `.capshelf/local.lock.json` are gitignored by `.capshelf/.gitignore` and store the per-machine data repo path plus local-only item intent and pins. By default, skills are installed as real directories under `.agents/skills/<name>` and exposed to Claude through per-skill symlinks at `.claude/skills/<name>`. Use `capshelf init --claude-only` only when a project should install directly under `.claude/` without `.agents` symlinks.

Project commands must be run from the project root, the directory containing
`.capshelf/capshelf.json`. Capshelf does not walk upward from subdirectories or
fall back to Git roots. `init` creates `.capshelf/` in the current directory.

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

| verb | purpose | availability |
|---|---|---|
| `init` | scaffold a new project (manifest + lock, install bundled system items, bind data repo) | implemented |
| `set-data <path>` | bind this machine to the project's data repo clone via `.capshelf/local.json` | implemented |
| `set-upstream <url>` | write the committed `dataRepoUpstream` URL in `.capshelf/capshelf.json` | implemented |
| `ls` | list items in master (default) or in this project (`--here`) | implemented |
| `show <item>` | print metadata + content for one item | implemented |
| `status [<item>]` | drift / update report for this project; `--project` and `--local` filter scopes; `--diff` explains local drift | implemented |
| `add <item>` | install an item from the bound data repo; `--local` installs a clone-local skill | implemented |
| `rm <item>` | remove from this project; `--local` removes clone-local skills | implemented |
| `get-path <item>` | print the editable path; skills return their managed directory, fragments support `--output` for generated output paths, and MCP supports `--target` | implemented |
| `apply [<item>]` | reconcile project and local files with lockfiles (data items via `git show <sourceCommit>`; system items from bundled content; fragments via merged outputs); supports `--local` and `--dry-run` | implemented |
| `update [<item>...]` | bump project pins by default; `--local` or an explicit local-only skill ref updates local pins; supports `--dry-run` | implemented |
| `share <item>` | adopt a not-yet-shared on-disk item into the data repo; fragments require `--from` and project scope | implemented |
| `move <item> --to <scope>` | move an already-tracked data item between local and project scope without changing data-repo content | implemented |
| `promote <item>` | push edits for an already-tracked data item to the data repo; fragments promote canonical source files; `--local` selects local-scope skills | implemented |
| `keep-local <item>` | mark drifted copy-item content as intentional project-local divergence; supports `--local` for skills and rejects fragments | implemented |
| `revert <item>` | discard local edits, restore locked version; supports `--local` | implemented |
| `self-update` | check for and install a Homebrew update for the capshelf binary; supports `--check` and `--yes` | implemented |
| `validate <name>` | lint an item (frontmatter, structure, broken refs) | roadmap |
| `diff <name> [<ref>]` | show what would change on apply/update/promote | roadmap |
| `doctor` | audit integrity (requires/conflicts, lockfile drift, uniqueness, system/data namespace collisions) | roadmap |
| `journal` | recent activity (who/when/what) | roadmap |
| `search` | fuzzy-find by name/tag across the data repo | roadmap |
| `bundle` | apply / save / list bundles | roadmap |

## Common Flags

- `--data <path>` — global override for the data repo (otherwise resolved from `.capshelf/local.json`, then `$CAPSHELF_HOME`, then fail)
- `--json` — per-command structured output where supported
- `--dry-run` — supported by `apply` and `update`; previews planned writes without changing files or lock state
- `--diff` — supported by `status`; shows local drift against the locked
  content without changing files. For copy items, extra current files are
  filtered through `.gitignore` files inside the installed item.
- `--target claude|codex` — used by multi-target MCP fragment commands such as `show`, `get-path`, and `share`

## Binary self-update

`capshelf update` updates project item pins and managed config. Binary updates
use the separate `self-update` command.

```bash
capshelf self-update --check
capshelf self-update
capshelf self-update --yes
```

For Homebrew installs, `self-update --check` reports the current CLI version,
latest Homebrew formula version, update availability, and installer. `self-update`
prompts before running `brew upgrade --formula genged/tap/capshelf`; `--yes`
runs the same upgrade non-interactively when an update exists. After a successful
binary update, restart capshelf.

Startup checks are best-effort and cached for 24 hours. They prompt only when
stdin and stderr are TTYs, `CI` is unset, `NODE_ENV` is not `test`,
`CAPSHELF_NO_SELF_UPDATE` is unset, the command is not help/version,
`self-update`, or a `--json` invocation, and the running executable resolves to
the Homebrew-managed `capshelf` binary.

Source installs are not upgraded automatically. Update them manually:

```bash
git pull
make install
```

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
| 3 | conflict (promote would clobber, operation rejected on a system item, untracked target would be overwritten, or path is managed by skills.sh) |
| 4 | drift detected (for `status --strict`) or upstream verification failed |
| 5 | reserved for future unmet-requires checks |
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

## The edit loop

The core agent-driven flow. Works on data items only — system items are read-only from the project's perspective.

```
 agent: capshelf get-path security-review
   ← .agents/skills/security-review

 agent: Edit tool on .agents/skills/security-review/SKILL.md

 agent: capshelf status security-review --json
   ← {
       "items": [
         {
           "scope": "project",
           "source": "data",
           "kind": "skills",
           "name": "security-review",
           "state": "drifted_local",
           "lockedSha": "9f2c1e",
           "currentSha": "fa17b2",
           "upstreamSha": "9f2c1e",
           "sourceCommit": "abc123"
         }
       ]
     }

 agent (or user) chooses:
   capshelf promote security-review -m "add SQLi check"
   capshelf keep-local security-review --reason "proj-A uses stricter rules"
   capshelf revert security-review     # uses sourceCommit + git show to restore
```

## Adopting a local skill

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
Local-scope skill adoption and promotion copy only files visible after applying
the skill directory's own `.gitignore` files. In Git projects, local-scope
skills also add their install paths to `.git/info/exclude`; non-Git projects
skip Git excludes and rely on `.capshelf/local.json` plus `.capshelf/local.lock.json`.

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

Homebrew:

```
brew install genged/tap/capshelf
```

Source install:

```
make install        # builds binary, copies to ~/.local/bin/capshelf
```

Dev loop:

```
bun run src/cli.ts <verb> [args]    # run source directly, no build
```

## Why no MCP server in v1

An MCP server would let agents call `capshelf_add`, `capshelf_status`, etc. as first-class tools without shelling out. It's a better interface long-term. But:

- The bootstrap skill (bundled into the CLI binary, installed by every `init`) tells any agent reading it how to use the CLI — that's enough for v1.
- Agents already have `Bash` tool, so `bash(capshelf status)` works today.
- Adding MCP is straightforward later — same operations, different transport. Defer until the CLI is stable.

## What a human still does

1. Approve a `promote` when the agent surfaces it.
2. Glance at `capshelf status` when starting a project.
3. Make project-specific policy decisions for new projects.

Everything else in the current CLI surface — inspect, edit, share, move,
promote, and reconcile — is the agent's job. Search, validation, and bundles
are roadmap workflow extensions.

## Config Fragments

Fragments are data repo source files merged into project-owned config outputs:

| Item ref | Source path | Output |
|---|---|---|
| `settings/<name>` | `settings/<name>/settings.json` | `.claude/settings.json` |
| `mcp/<name> --target claude` | `mcp/<name>/claude.json` | `.mcp.json` |
| `mcp/<name> --target codex` | `mcp/<name>/codex.toml` | `.codex/config.toml` |
| `codex-config/<name>` | `codex/config/<name>/config.toml` | `.codex/config.toml` |

`mcp/<name>` is one logical item. It can have a Claude target, a Codex target,
or both. If both source files exist, `get-path mcp/<name>` requires
`--target claude|codex`; `get-path --output` returns the generated output path.

Examples:

```bash
capshelf add settings/security-base
capshelf add mcp/github
capshelf add codex-config/defaults

capshelf get-path mcp/github --target codex
capshelf get-path mcp/github --target codex --output
capshelf status mcp/github --diff
```

Generated outputs preserve unmanaged project-local values. On reconciliation,
capshelf removes the old managed contribution, keeps local values, detects
unmanaged scalar or shape collisions, and then merges the newly locked fragments.
Arrays concatenate with deterministic dedupe; objects and TOML tables merge
recursively; scalars are last-fragment-wins. TOML comments in rewritten
`.codex/config.toml` are not preserved.

`share` for fragments requires an explicit source file and project scope:

```bash
capshelf share settings/security --from ./settings.json --to project
capshelf share mcp/github --target claude --from ./claude-mcp.json --to project
capshelf share mcp/github --target codex --from ./codex-mcp.toml --to project
capshelf share codex-config/defaults --from ./config.toml --to project
```

`promote` commits canonical source files, not generated outputs. For example,
edit the path from `capshelf get-path mcp/github --target codex`, then run
`capshelf promote mcp/github -m "update github mcp"`. `keep-local` and local
scope are rejected for fragments; put project-only values directly in
`.claude/settings.json`, `.mcp.json`, or `.codex/config.toml`.

Codex only loads `.codex/config.toml` from trusted projects. When `codex` is on
`PATH` and the current project does not appear trusted in Codex user config,
`status` reports a warning without changing `status --strict` exit behavior.

Old MCP copy-dir behavior is gone: capshelf does not write
`.agents/mcp/<name>` and does not install `mcp/<name>/fragment.json`.
