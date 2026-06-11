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
| `data-path` | print the resolved local data repo path; `--json` includes the path and the normalized upstream (`null` when absent) | implemented |
| `sync-data` | explicitly fetch the bound data repo's `origin` and fast-forward the current branch when provably safe; the only capshelf command that performs network I/O besides the `init --data <url>` bootstrap clone and `self-update` | implemented |
| `ls` | list items in master (default) or in this project (`--here`); shows descriptions and `#tags` from item metadata; `--tag` filters | implemented |
| `show <item>` | print metadata + content for one item, including `requires`/`conflicts-with` install state; `--json` always carries a `metadata` object | implemented |
| `search <query...>` | search available items (data repo + system) by name, tags, description, and content; supports `--kind` and `--json`; zero matches exit 0 | implemented |
| `status [<item>]` | drift / update report for this project; `--project` and `--local` filter scopes; `--diff` explains local drift; reports `missing_source_commit` when a locked `sourceCommit` is unreachable in the data repo | implemented |
| `add <item>` | install an item from the bound data repo; `--local` installs a clone-local skill; warns on unmet `requires`, refuses on `conflicts-with` (exit 3) | implemented |
| `rm <item>` | remove from this project; `--local` removes clone-local skills | implemented |
| `get-path <item>` | print the editable path; skills return their managed directory, fragments support `--output` for generated output paths, and MCP supports `--target` | implemented |
| `apply [<item>]` | reconcile project and local files with lockfiles (data items via `git show <sourceCommit>`; system items from bundled content; fragments via merged outputs); supports `--local` and `--dry-run` | implemented |
| `update [<item>...]` | bump project pins by default; `--local` or an explicit local-only skill ref updates local pins; supports `--dry-run` | implemented |
| `share <item>` | adopt a not-yet-shared on-disk item into the data repo; fragments require `--from` and project scope | implemented |
| `move <item> --to <scope>` | move an already-tracked data item between local and project scope without changing data-repo content | implemented |
| `promote <item>` | push edits for an already-tracked data item to the data repo; fragments promote canonical source files; `--local` selects local-scope skills; refuses stale promotes unless `--stale-ok` | implemented |
| `keep-local <item>` | mark drifted copy-item content as intentional project-local divergence; supports `--local` for skills and rejects fragments | implemented |
| `revert <item>` | discard local edits, restore locked version; supports `--local` | implemented |
| `self-update` | check for and install a Homebrew update for the capshelf binary; supports `--check` and `--yes` | implemented |
| `validate <name>` | lint an item (frontmatter, structure, broken refs) | roadmap |
| `diff <name> [<ref>]` | show what would change on apply/update/promote | roadmap |
| `doctor` | audit integrity (requires/conflicts, lockfile drift, uniqueness, system/data namespace collisions) | roadmap |
| `journal` | recent activity (who/when/what) | roadmap |
| `bundle` | apply / save / list bundles | roadmap |

## Common Flags

- `--data <path>` — global override for the data repo (otherwise resolved from `.capshelf/local.json`, then `$CAPSHELF_HOME`, then fail)
- `--json` — per-command structured output where supported
- `--dry-run` — supported by `apply` and `update`; previews planned writes without changing files or lock state
- `--diff` — supported by `status`; shows local drift against the locked
  content without changing files. For copy items, extra current files are
  filtered through `.gitignore` files inside the installed item.
- `--target claude|codex` — used by multi-target MCP fragment commands such as `show`, `get-path`, and `share`
- `--tag <tag>` — supported by `ls` (including `--here`); repeatable, and
  repeated tags narrow with AND. Comparison is case-insensitive; combine with
  `--kind` to narrow further. Use `search` or two invocations for OR.

## Item metadata

Items can carry catalog metadata from two sources: an optional
`.capshelf.yml` sidecar at the item directory root in the data repo (all
kinds) and SKILL.md YAML frontmatter (skills only). The sidecar declares
`description`, `tags`, `requires`, and `conflicts-with` (kind-qualified
`<kind>/<name>` refs); frontmatter contributes only a fallback `description`.

`ls` appends a description (truncated to 60 characters) and `#tags` to each
row; `ls --json` rows gain optional `description` and `tags` fields
(append-only, omitted when absent). `ls --here` enriches installed rows
best-effort from the bound data repo's working tree — when no data repo is
bound or the item no longer exists upstream, the fields are omitted and
nothing fails.

`show <item>` prints the full metadata between the lock info and the content
dump — description, tags, and each `requires`/`conflicts-with` ref with its
install state (`installed` means present in either `capshelf.lock.json` or
`local.lock.json`). `show --json` always includes a `metadata` object with
`tags`, `requires`, and `conflictsWith` (possibly empty) so consumers can
rely on the key; `description` is included when present.

The sidecar is catalog data, not item content: it is never hashed, never
materialized into projects, and a metadata-only data-repo commit never makes
`status` report drift or `update` rewrite a lock. Edit it in the data repo
and commit — no project `update` is needed afterwards. Malformed metadata
warns on stderr and degrades to no-metadata; it never fails a read command.

### add enforcement

`add` enforces sidecar relations before any writes, on both scopes:

- **`requires` — warn, exit 0.** Each required ref missing from both locks is
  printed to stderr with the exact fix command
  (`<ref> — install with: capshelf add <ref>`); `add --json` appends a
  `missingRequires` array (omitted when empty). The install still succeeds —
  exit 5 stays reserved for a future `doctor`/strict audit.
- **`conflicts-with` — refuse, exit 3, no override flag.** The check is
  symmetric: it refuses when the new item declares a conflict with an
  installed item, or when any installed data item declares a conflict with
  the new item. The error names the declaring sidecar and the two escape
  hatches: remove the conflicting item (`capshelf rm <ref>`), or fix a stale
  declaration in the data repo and commit.

Refs pointing at items deleted upstream are reported as missing requires and
skipped for conflicts — `add` never fails because a referenced item is gone.
Only `add` enforces relations; `update`, `apply`, and `rm` do not re-check.

## search

`capshelf search <query...> [--kind <kind>] [--json]` searches data items in
the bound data repo plus bundled system items across four fields: the
`<kind>/<name>` ref, tags, the resolved description, and item content
(git-visible files for skills; canonical source files for fragments — the
installed merged outputs are never read, so one fragment's text is never
attributed to another).

The query is split on whitespace into terms; every term must match (AND) as a
case-insensitive substring of some field. Results are ranked by summed field
weights (name 8, tag 4, description 2, content 1), tie-broken by `kind/name`.
Content scanning skips files over 256 KiB, files containing a NUL byte, and
`.capshelf.yml` itself. Zero matches print `(no matches)` (or `"results": []`)
and exit 0 — an empty answer is a valid answer. Tag filtering belongs to
`ls --tag`; putting tags in the query already matches them.

```bash
capshelf search "sql injection"
capshelf search security --kind skills --json
```

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

## Remote data repo bootstrap

`init --data` also accepts a remote data repo URL:

```
capshelf init --data https://github.com/genged/agent-shared
capshelf init --data git@github.com:genged/agent-shared.git
capshelf init --data https://github.com/genged/agent-shared --data-dir ~/code/agent-shared
```

A remote URL is bootstrap input, not the runtime data repo. Capshelf clones it
once into a predictable local path, then continues exactly as if that local
clone had been passed to `--data`:

- Default clone path: `$XDG_DATA_HOME/capshelf/data/<host>/<owner-path>/<repo>`
  (falling back to `~/.local/share`), derived from the normalized remote
  identity with credentials and one trailing `.git` stripped.
- `--data-dir <path>` overrides the clone destination.
- The clone path is written to gitignored `.capshelf/local.json` and the
  normalized remote identity to `dataRepoUpstream` in `.capshelf/capshelf.json`.
- `file://` URLs are accepted as bootstrap input (useful for local mirrors and
  testing) but are never recorded as `dataRepoUpstream`: a machine-local path
  is not a portable upstream, and `set-upstream` rejects `file://` URLs.
- Passing `--upstream` alongside a remote `--data` URL requires both to
  normalize to the same identity; a mismatch fails with exit 4 before
  anything is cloned or written.
- If the clone path already exists, it must be a git working tree whose
  `origin` matches the URL; otherwise `init` fails and asks for an explicit
  local path.
- Capshelf never fetches or pulls the clone during later commands, and
  `promote` still commits locally only.

Supported forms are full remote URLs: `https://host/owner/repo[.git]`,
`git@host:owner/repo[.git]`, and `ssh://git@host/path/repo[.git]`. Shorthand
such as `owner/repo` or `github:owner/repo` is rejected. `set-data` stays a
local-path binding command; pass remote URLs only to `init --data`.

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

`set-data` accepts only local paths. Passing a remote data repo URL fails with
exit 3 and points at `capshelf init --data <remote-data-repo-url>` for new
projects, or a manual `git clone` plus `set-data <path>` for existing ones.

Use `capshelf set-upstream <url>` to add or change the committed upstream URL.
The URL is normalized before writing. Unsupported URL shapes are rejected.

Both `set-data` and `set-upstream` support `--json`: `set-data --json` prints
`{ project, dataRepo }` with the resolved absolute path, and
`set-upstream --json` prints `{ project, dataRepoUpstream }` with the
normalized URL.

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

## Syncing the data repo

```bash
capshelf sync-data [--json]
```

A project command, run from the project root. `sync-data` is the only capshelf
command that touches the network, and only when you run it. It resolves the
data repo through the standard chain, runs the usual upstream verification
when the manifest declares `dataRepoUpstream` (a declared upstream is *not*
required — it syncs whatever `origin` is), fetches `origin`, and fast-forwards
the current branch only when that is provably safe: clean worktree, attached
HEAD, not ahead of the integration target. The integration target is the
branch's configured `@{upstream}`, falling back to `origin/<branch>` for this
run only (capshelf never writes branch config). Everything else stops with
copy-pasteable git guidance — capshelf never rebases, merges (non-ff), resets,
stashes, or pushes the user-owned clone.

Exactly one outcome state per run (fetch has already happened in all states
except `no_origin` and `fetch_failed`):

| state | condition | branch moved? | exit |
|---|---|---|---|
| `up_to_date` | `behind == 0`, `ahead == 0` (clean or dirty) | no | 0 |
| `fast_forwarded` | clean, attached, `ahead == 0`, `behind > 0` | ff only | 0 |
| `local_ahead` | `ahead > 0`, `behind == 0` (clean or dirty) | no | 0 |
| `diverged` | `ahead > 0`, `behind > 0` (clean or dirty) | no | 4 |
| `dirty_worktree` | dirty, `ahead == 0`, `behind > 0` | no | 4 |
| `detached_head` | HEAD detached | no | 3 |
| `no_tracking_ref` | no `@{upstream}` and no `origin/<branch>` | no | 3 |
| `no_origin` | no `origin` remote | — | 3 |
| `fetch_failed` | `git fetch origin` failed | — | 1 |

`local_ahead` is exit 0 with `git push` guidance: unpushed promote commits are
a designed, intentional state, not an error. Worktree dirtiness selects a
state only when it blocks an otherwise-possible fast-forward
(`behind > 0 && ahead == 0`); otherwise it is reported via the `dirty` JSON
field without affecting state or exit code. `--json` prints the full report
(`dataRepo`, `origin`, `branch`, `trackingRef`, `fetched`, `state`, `before`,
`after`, `ahead`, `behind`, `dirty`, `guidance`) before any non-zero exit, so
scripts always get the report. See `docs/team-workflow.md` for the team loop
this command closes.

## Exit codes

| code | meaning |
|---|---|
| 0 | success |
| 1 | generic error (missing args, bad config, I/O) |
| 2 | item not found in data repo |
| 3 | conflict (promote would clobber, operation rejected on a system item, untracked target would be overwritten, path is managed by skills.sh, `add` refused by a `conflicts-with` declaration, or `sync-data` cannot run in the current configuration: detached HEAD, no tracking ref, no origin) |
| 4 | drift detected (for `status --strict`), upstream verification failed, or `sync-data` needs human action (diverged history, or upstream commits blocked by a dirty worktree) |
| 5 | reserved for future unmet-requires checks (`add` with unmet `requires` warns and exits 0) |
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

After a promoted commit, `promote` prints where the commit landed:

```text
committed to local data repo:
  ~/.local/share/capshelf/data/github.com/genged/agent-shared
```

and, when the data repo has an `origin` remote, how to share it:

```text
to share upstream:
  cd ~/.local/share/capshelf/data/github.com/genged/agent-shared
  git push
```

Capshelf never pushes implicitly. `promote --json` includes the resolved
`dataRepo` path and a `dataRepoHasOrigin` boolean.

### Stale-promote protection

`promote` refuses to overwrite data-repo content that is newer than this
project's lock (exit 3): if the item changed upstream since the project last
updated, the error shows the locked vs upstream shas, a scoped `git log` of
the upstream advance, and the two ways out — `capshelf update <item>` to take
the upstream version first, or `capshelf promote <item> --stale-ok` to
overwrite on purpose. Two related behaviors:

- **Uncommitted data-repo edits inside the item's path always block** (exit
  3) and are *not* bypassable by `--stale-ok`: they have no commit
  provenance, so commit or discard them in the data repo first.
- **Convergence**: when the content being promoted is byte-identical to what
  upstream already has, promote succeeds without a commit, re-pins the lock
  to the upstream commit, and reports the action `"already-upstream"`.

`promote --json` notes: `action` may be `"already-upstream"` (consumers must
tolerate new action values), and `staleOverride: true` appears only when
`--stale-ok` actually bypassed a stale check (absent otherwise, including
when the flag was passed but nothing was stale).

### missing_source_commit

`status` checks that each data item's locked `sourceCommit` is reachable in
the data repo. When it is not (squash/rebase-merged proposal branch, or a
promote commit that only exists in another clone), the row reports
`missing_source_commit` and `status --strict` exits 4. Fix by re-pinning:
`capshelf sync-data && capshelf update <item>` (metadata-only when the
content sha is unchanged), or push/fetch the clone that has the commit. See
[`docs/team-workflow.md`](team-workflow.md) for the team loop, the
propose-upstream recipe, and the CI gate built on this state.

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

`promote --create` and `promote --local --to-project` have been removed; use
`share` for adoption and `move --to <scope>` for scope changes.

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

Release binary without Homebrew (verifies the published SHA-256 manifest,
installs to `~/.local/bin/capshelf`):

```
curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh
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
promote, and reconcile — is the agent's job, and `search` plus item metadata
give it the discovery loop. Validation and bundles are roadmap workflow
extensions.

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
`.codex/config.toml` are not preserved. TOML date/time values are rejected in
fragment sources: capshelf's merge and hash pipeline round-trips values through
JSON, which cannot preserve TOML date types (a local date would silently become
a string or an offset date-time on re-emit).

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
