# CLI surface

## Design principles

1. **Agent-first.** The primary user is a coding agent, not a human. Commands expose `--json` where structured output is useful. Stable exit codes.
2. **Verbs over flags.** `add`, `rm`, `share`, `move`, and `promote` are first-class. You rarely type a path.
3. **Kind inference.** Bare names work when they resolve to one item. Disambiguate with `skills/security-review` if needed.
4. **Read-only by default for foreign projects.** `update` in project A cannot affect project B. `share` and `promote` write only the bound data repo and the calling project; B only changes when it runs `update` or `add`.
5. **No silent writes.** Mutating commands show what they touched; use `--json` where scripts need structured output.

Claude custom commands are modeled as skills. capshelf does not manage `.claude/commands/`; create `skills/<name>/SKILL.md` for a reusable `/<name>` entry. Project-local Pi extensions are modeled as `pi-extensions/<name>` copy items. Claude and Codex custom agents are one project-scoped `subagents/<name>` item.

Capshelf metadata lives under `.capshelf/` at the project root. `.capshelf/capshelf.json` and `.capshelf/capshelf.lock.json` are committed; `.capshelf/local.json` and `.capshelf/local.lock.json` are gitignored by `.capshelf/.gitignore` and store the per-machine data repo path plus local-only item intent and pins. By default, skills are installed as real directories under `.agents/skills/<name>` and exposed to Claude through per-skill symlinks at `.claude/skills/<name>`. Use `capshelf init --claude-only` only when a project should install directly under `.claude/` without `.agents` symlinks.

Project commands can be run from the project root — the directory containing
`.capshelf/capshelf.json` — or any subdirectory of it: capshelf walks upward to
find the nearest project root, like git/npm/cargo. It does not fall back to Git
roots. `init` acts on the current directory (no upward discovery), so it creates
`.capshelf/` exactly where it is run.

The read-only browse commands — `ls`, `search`, `show` — are the exception:
they also run outside any project when a data repo is given via `--data` or
`$CAPSHELF_HOME`, so a shelf can be evaluated before it is adopted. Inside a
project they use its binding and show install/tracking status as usual.

Claude also loads personal skills from `~/.claude/skills/<name>`. If a personal
skill has the same name as a project-managed skill, Claude will use the personal
skill first. Capshelf does not manage the personal copy, but `init`, `add`,
`apply`, `update`, `revert`, `promote`, and `status` warn with
`shadowed_by_personal_claude_skill`. `status` also lists the shadowing skill in
`external/  (Personal Claude)`, and `status --strict` exits 4 while the shadow
exists.

Capshelf also inventories user-level runtime skills without taking ownership:
`capshelf ls` and `capshelf status` include skills from `~/.claude/skills`,
`~/.agents/skills`, and `$CODEX_HOME/skills` (defaulting to
`~/.codex/skills`) by default. Hidden directories such as `.system` are
ignored. The `--user` flag narrows `ls` or `status` to only this user-level
inventory and does not require a capshelf project or data repo.

Most item arguments accept either a bare unique name (`hello`) or an explicit kind/name ref (`skills/hello`). Lock keys such as `data/skills/hello` are internal and are not accepted as normal item refs.

Mutating commands only touch item files that are tracked in `.capshelf/capshelf.lock.json` or `.capshelf/local.lock.json`. `add` refuses to overwrite an existing untracked target, `init` refuses to overwrite an existing untracked system target, and `rm` deletes only locked data items. Copy-directory items—skills and Pi extensions—can use either committed project scope or clone-local scope. Use `share <item> --to local|project` to choose when adopting an unmanaged copy.

Copy-item names reject control characters, and copy-item trees accept regular
files only. Symlinks, Git links, and special filesystem objects are refused at
both working-tree and committed-object boundaries. Executable intent is
normalized to Git modes `100644` and `100755`; status, promote, apply, and
update preserve and compare that mode without changing the existing content
hash format.

## Command surface

| verb | purpose | availability |
|---|---|---|
| `init` | scaffold a new project or onboard a fresh clone without a local binding (manifest + lock, bundled system items, data repo); refuses an already initialized machine | implemented |
| `data bind <path>` | bind this machine to the project's data repo clone via `.capshelf/local.json` (alias: `set-data`) | implemented |
| `data upstream <url>` | write the committed `dataRepoUpstream` URL in `.capshelf/capshelf.json` (alias: `set-upstream`) | implemented |
| `data path` | print the resolved local data repo path; `--json` includes the path and the normalized upstream (`null` when absent) (alias: `data-path`) | implemented |
| `data sync` | explicitly fetch the bound data repo's `origin` and fast-forward the current branch when provably safe; the only capshelf command that performs network I/O besides the `init --data <url>` bootstrap clone and `self-update` (alias: `sync-data`) | implemented |
| `ls` | list items in master plus user-level runtime skills by default, in this project (`--here`), or user-level runtime skills only (`--user`); master/project listings show descriptions and `#tags` from item metadata; `--tag` filters master/project listings; appends a `bundles/` section for data-repo bundles | implemented |
| `show <item>` | print metadata + content for one item, including relations and current/locked declared needs; `--target` narrows MCP or subagent runtime content | implemented |
| `search <query...>` | search available items (data repo + system) and bundles by name, tags, description, and content; supports `--kind` and `--json`; zero matches exit 0 | implemented |
| `status [<item>]` | drift / update report plus orthogonal `needsState` freshness and locked needs; subagent JSON includes deterministic per-target state; `--project` and `--local` filter scopes; `--user` shows only user-level runtime skills; `--diff` explains local drift | implemented |
| `add <item>` | install a new item from the bound data repo; an already-installed standalone item is a byte- and lock-stable no-op; `--local` installs a clone-local copy item; `--yes` authorizes collateral fragment-output loss for a new fragment | implemented |
| `rm <item>` | remove a locked data item; clean reproducible content is prompt-free, while local edits, modes, extra paths, subagent drift, and fragment comment loss require consent or `--yes` | implemented |
| `get-path <item>` | print the editable path; subagents and MCP support `--target`, while `--output` returns the corresponding runtime output | implemented |
| `apply [<item>]` | reconcile project and local files with lockfiles after full-set destructive preflight; supports `--local`, `--dry-run`, and `--yes` | implemented |
| `update [<item>...]` | bump content and declared-needs pins; needs-only changes do not reinstall unchanged content; `--local` updates clone-local copy-item pins; supports `--dry-run` and explicit drift overwrite consent with `--yes` | implemented |
| `share <item>` | adopt a not-yet-shared on-disk item into the data repo; subagents scan both runtime outputs by default and require `--target` with `--from` | implemented |
| `move <item> --to <scope>` | move an already-tracked data item between local and project scope without changing data-repo content | implemented |
| `promote <item>` | push edits for an already-tracked data item to the data repo; fragments promote canonical source files; `--local` selects clone-local copy items; stale copy items can use `--merge` or intentional overwrite with `--stale-ok` | implemented |
| `keep-local <item>` | mark drifted copy-item content as intentional divergence; supports project and clone-local skills/Pi extensions, and rejects fragments | implemented |
| `revert <item>` | restore one locked version; already-current is a lock-stable no-op, while discarding local state requires consent or `--yes`; supports `--local` | implemented |
| `self-update` | check for and install a Homebrew update for the capshelf binary; supports `--check` and `--yes` | implemented |
| `marketplace ...` | author, validate, sync, rename/retire, and package independent Claude/Cowork and Codex plugin catalogs in the data repo | implemented |
| `validate <name>` | lint an item (frontmatter, structure, broken refs) | roadmap |
| `diff <name> [<ref>]` | show what would change on apply/update/promote | roadmap |
| `doctor` | audit integrity (requires/conflicts, lockfile drift, uniqueness, system/data namespace collisions) | roadmap |
| `journal` | recent activity (who/when/what) | roadmap |

Bundles ride the existing `add`/`show` verbs with a `bundles/<name>` ref —
there is no separate `bundle` verb family. See Bundles below.

## Plugin marketplaces

Marketplace commands operate on the resolved Git data repo and work outside a
Capshelf project with `--data` or `$CAPSHELF_HOME`. Plugin definitions are
catalog state, not items: no project manifest or lock is changed.

```bash
capshelf marketplace init --target claude --name company --owner Engineering
capshelf marketplace init --target codex --name company-codex --owner Engineering
capshelf marketplace plugin create engineering --target claude \
  --skill skills/code-review --skill skills/test-planning
capshelf marketplace plugin create engineering --target codex \
  --skill skills/code-review
capshelf marketplace ls
capshelf marketplace show engineering
capshelf marketplace validate
```

Target mutations require `--target claude|codex`. Supported mutations are
marketplace `init`/`edit` and plugin `create`/`edit`/`add-skill`/
`remove-skill`/`rename`/`delete`. They require a clean data repo, validate the
complete target, stage only owned paths, create one local commit, never push,
and support `--dry-run`, `--json`, and `-m`. A failed commit restores the
source, generated paths, index, and HEAD when Capshelf still owns the observed
HEAD. If another process commits concurrently, Capshelf never rewinds that
commit; it restores only unchanged owned roots that are safe to restore.
Claude preserves structurally external entries but refuses to mutate them.

Marketplace and plugin identities use kebab-case. Claude marketplace names
also reject Anthropic's current reserved names and obvious official
impersonation. `plugin create` requires at least one selected skill. Codex
installation policy accepts `NOT_AVAILABLE`, `AVAILABLE`, or
`INSTALLED_BY_DEFAULT`; authentication policy accepts `ON_INSTALL` or
`ON_USE`. Options that do not apply to the selected target are errors.

Codex source definitions live under `codex/plugin-definitions/`. The generated
native catalog and self-contained plugin roots live at
`.agents/plugins/marketplace.json` and `codex/generated/`. Run:

```bash
capshelf marketplace sync --target codex --dry-run --json
capshelf marketplace validate --target codex
codex plugin marketplace add /path/to/data-repo
```

Sync reads dirty definitions and skills, repairs only generated paths, and
never stages or commits. Clean committed projection drift is repaired without
a prompt. Dirty affected projection paths are listed and require interactive
consent or `--yes`; review them first with the dry-run above. Skill `share` and `promote` regenerate the complete
configured Codex projection in the same source commit. Codex generated plugin
versions are deterministic `0.0.0+codex.<hash>` cachebusters. Codex
initialization refuses any pre-existing source or generated root instead of
claiming or deleting unknown files.

`marketplace validate --json` returns target-labeled `configured` and `valid`
state, Codex projection/source paths, Claude repository and selected-plugin
file/byte totals and known Cowork limits, and Codex
canonical/generated/duplicated byte totals.
Validation issues are structured objects with stable `code`, `message`, and
target-specific fields. `--distribution` validates hosted Claude distribution
and requires a configured Claude marketplace. `--cowork-url` is valid only
with `--distribution`; an invalid URL stays in the full validation report and
exits 4. A valid explicit URL is reported as user-asserted support and emits a
structured warning, so `--strict` exits 4. `--target` and `--distribution` are
mutually exclusive.

`marketplace plugin pack` requires a target and an output outside the data
repo. Claude produces a deterministic root-content `.plugin` ZIP for Cowork
upload; Codex produces a detached one-plugin marketplace directory. Packaging
uses current Git-visible working-tree bytes by default; `--from-head` selects
committed bytes. Symlinks, private dotenv files, unsafe output containment,
unsafe generated paths, and non-identical output replacement are refused.
Containment follows real paths through the nearest existing ancestor, so a
lexically external output cannot re-enter the data repo through a symlink.
Tracked files use Git executable intent; untracked files use filesystem mode.
Rebuilding identical output returns `already-built`.

Plugin membership must always name existing canonical skills. For a direct
data-repo skill rename, rename the skill and update every Claude/Codex
membership in the same Git change, then run Codex sync and marketplace
validation. Remove all memberships before deleting a skill. Dangling selected
skills block validation, sync, pack, and catalog mutations.

Capshelf prints runtime handoff commands but does not register marketplaces,
install plugins, update caches, push commits, or claim a runtime accepted the
result.

## Common Flags

- `--data <path>` — global override for the data repo (otherwise resolved from `.capshelf/local.json`, then `$CAPSHELF_HOME`, then fail)
- `--json` — per-command structured output where supported
- `--dry-run` — supported by `apply`, `update`, and `marketplace sync`; previews planned writes and destructive-change records without changing state
- `--yes` — supported by `add`, `apply`, `update`, `rm`, `revert`,
  `marketplace sync`, and `self-update`. It authorizes only destructive changes
  enumerated by preflight; it never bypasses path safety, source cleanliness,
  fragment collisions, stale promotion, or transaction checks.
- `--user` — supported by `ls` and `status`; narrows output to user-level
  runtime skills only, without requiring a capshelf project or data repo
- `--diff` — supported by `status`; shows local drift against the locked
  content without changing files. For copy items, extra current files are
  filtered through `.gitignore` files inside the installed item.
- `--target claude|codex` — used by multi-target MCP and subagent commands such as `show`, `get-path`, and `share`
- `--tag <tag>` — supported by `ls` (including `--here`); repeatable, and
  repeated tags narrow with AND. Comparison is case-insensitive; combine with
  `--kind` to narrow further. Use `search` or two invocations for OR.

## Item metadata

Items can carry catalog metadata from two sources: an optional
`.capshelf.yml` sidecar at the item directory root in the data repo (all
kinds) and SKILL.md YAML frontmatter (skills only). The sidecar declares
`description`, `tags`, `requires`, `conflicts-with` (kind-qualified
`<kind>/<name>` refs), and `needs`; frontmatter contributes only a fallback
`description`.

For skills, the sidecar `description` is optional and usually unnecessary —
frontmatter fills it in. It exists because (a) fragment kinds have no
frontmatter, so the sidecar is their only source and one schema covers all
kinds; (b) the costs differ: frontmatter is shipped to Claude and hashed, so
editing it is content drift that every consuming project must `update`
through, while a sidecar edit causes no drift at all; and (c) the audiences
differ: frontmatter is the runtime invocation trigger Claude reads ("Use
when…"), while the sidecar is catalog copy for whoever browses the shelf.
Use a sidecar `description` on a skill only when the catalog blurb should
differ from the trigger phrasing, or to tune copy without shipping a
content change. When both exist, the sidecar wins.

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
`tags`, `requires`, `conflictsWith`, and `needs` (possibly empty) so consumers
can rely on the keys; `description` is included when present.

The sidecar is catalog data, not item content: it is never hashed or
materialized into projects. Tags, descriptions, and relations remain live
catalog data and need no project update. Declared needs are pinned separately
in lock version 3: `status` can report a requirements update while content
stays `ok`, and `update` refreshes that snapshot without rewriting unchanged
installed bytes. Malformed metadata warns and degrades per field.

### declared needs

All item kinds may declare:

```yaml
needs:
  network: [api.example.com]
  env: [EXAMPLE_TOKEN]
  bin: [example-cli]
```

`network` values are lowercase bare hostnames; environment-variable and
command names preserve case. Invalid entries warn and are dropped. `add` and
`show` display `env`/`bin` declarations but never probe the host environment.

Capshelf treats all three fields as runtime-neutral declarations. It does not
inspect external runtime policy, check whether a requirement is satisfied, or
change runtime configuration. `status --json` includes `needsState` and
`lockedNeeds` for data items; `show --json` carries current metadata needs plus
installed `lockedNeeds`. Bundle previews union current member needs, while
bundle installs pin each member's declaration.

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
(git-visible files for copy items; canonical source files for fragments — the
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

Bundles are searched too (when no `--kind` filter is set): a bundle scores
its name, tags, and description with the same weights, and its member refs
score as the content field — `search postgres` surfaces the bundle that
includes `mcp/postgres-local`. Bundles interleave into the human ranked
list with a `bundles/` prefix; `search --json` keeps `results` items-only
and appends a sibling top-level `bundles` key.

## Bundles

A bundle is a named set of items defined as a single YAML file at the data
repo root, so "set up a new Go service" is one command:

```yaml
# bundles/go-backend.yml
description: Everything a Go backend service needs.
tags: [go, backend]
includes:
  skills:   [security-review, go-test-writer]
  settings: [permissions-base, permissions-go]
  mcp:      [github, postgres-local]
  codex-config: [defaults]
```

```bash
capshelf ls                          # bundles/ section appended
capshelf search "go backend"         # bundles rank alongside items
capshelf show bundles/go-backend     # preview members + install state
capshelf add bundles/go-backend      # expand
```

Semantics:

- **A bundle is a macro, not a versioning unit.** Expansion installs each
  member through the same pipeline as `capshelf add <kind>/<name>` — same
  checks, same `requires` warnings, same `conflicts-with` refusals, same
  independent lock entries. The bundle leaves **no trace** in the manifest
  or lock; the `bundle` field in `add --json` output is the only echo.
- **All-or-nothing.** Every deterministic refusal (missing member,
  conflict, cross-scope ownership, untracked target, dirty data-repo path,
  fragment unmanaged collision) is caught in a read-only preflight. Any
  failure prints a per-member report, makes no writes, and exits 3.
- **Converge on re-run.** Already-installed members are skipped with a
  note — never re-applied or pin-bumped (pin movement is `update`'s job).
  Re-running after the team grows the bundle adds only the new members.
- **Bundle names**: item-name rules plus `:` is rejected. Member names are
  bare (the kind is structural); member order within a kind flows into the
  manifest, so bundle authors control fragment merge precedence. Only
  `.yml` is recognized; `.yaml` warns and is ignored. Bundles cannot
  include bundles.
- **Scope**: `add bundles/<name> --local` works for copy-directory members
  (skills and Pi extensions); every project-only member (fragments and
  subagents) fails preflight with one aggregated error naming all unsupported
  members.
- **Freshness**: the bundle file is read from the data repo working tree
  and may be uncommitted (nothing pins it); member items still require
  clean, committed paths individually.
- **Reads degrade, installs refuse.** A malformed bundle stays visible in
  `ls` (name-only, stderr warning) but `add` refuses it — same for an
  `includes` kind this capshelf version does not know.
- `rm`, `status`, `update`, `promote`, and every other item command keep
  rejecting `bundles/<name>` — after expansion the members are ordinary
  items, and a traceless macro has nothing for them to operate on.

Bundles can include `pi-extensions` members. Like standalone extension adds,
they install at project scope by default and in clone-local scope when the
bundle is added with `--local`.

Bundles can also include `subagents` members. Subagents are project-scope only,
so a bundle containing one is rejected as a unit when added with `--local`.

## Subagents

One `subagents/<name>` item can carry a Claude definition, a Codex definition,
or both:

| Target | Canonical source | Project runtime output |
|---|---|---|
| Claude | `subagents/<name>/claude.md` | `.claude/agents/<name>.md` |
| Codex | `subagents/<name>/codex.toml` | `.codex/agents/<name>.toml` |

`add` always installs every available target under one manifest selection and
one `data/subagents/<name>` lock. `apply`, `update`, `revert`, `status`, and
`rm` reconcile that combined identity; when an update removes a canonical
target, its formerly managed runtime file is removed too.

Use `show --target` and `get-path --target` to select a runtime. If only one
canonical target exists, `get-path` can infer it; when both exist, it requires
`--target`. `get-path --output` returns the runtime file instead of the data
repo source.

`share subagents/<name> --to project` adopts every matching unmanaged runtime
output it finds. The explicit `--from <file>` form requires `--target`.
`promote` compares every managed output and commits only changed canonical
siblings. It preserves untouched target sources and applies the normal stale
guard; `--stale-ok` is the explicit overwrite escape hatch. A missing,
symlinked, or non-regular managed output refuses promotion with recovery
guidance. The complete projected canonical target set is validated before any
source is written.

Subagents do not support local scope, partial `add --target`, `keep-local`,
user-global installation, format translation, or `promote --merge`.

Claude sources require YAML frontmatter with non-empty `name` and
`description`, plus a non-empty Markdown prompt body. Codex sources require
non-empty TOML `name`, `description`, and `developer_instructions`. A runtime
name that differs from the Capshelf item name warns but does not fail.

Bundle exit codes:

| situation | code |
|---|---|
| `add bundles/<x>`: bundle file not found | 2 |
| `add bundles/<x>`: any preflight failure, malformed/unsupported bundle file, or `--local` with project-only members | 3 (per-member report printed first) |
| `add bundles/<x>`: all members already installed, or empty bundle | 0 |
| `add bundles/<x>`: unmet `requires` across the expanded set | 0 + stderr warning + JSON `missingRequires` |
| `show bundles/<x>`: bundle not found | 2 |
| `show bundles/<x>` with `--target`/`--no-content` | 3 |
| `bundles/<name>` passed to any other item command | 1 (invalid-kind error pointing at `add`/`show`) |

## Pi extensions

A data repo extension is a directory with a required entry point:

```text
pi/extensions/<name>/
  index.ts
  package.json       # optional metadata/dependencies
  src/…
  .capshelf.yml      # optional catalog metadata, never materialized
```

`capshelf add pi-extensions/<name>` copies the pinned Git-visible content to
`.pi/extensions/<name>/`, where Pi auto-discovers `index.ts` after project
trust. The committed manifest uses `piExtensions`, the clone-local manifest
uses the same field, and the lock key is `data/pi-extensions/<name>` in the
selected lock. Extensions support the same project/local lifecycle as skills:
`add`, `share`, `move`, `apply`, `update`, `promote`, `keep-local`, `revert`, and
`rm`. Both Capshelf scopes materialize to Pi's project-local extension path;
Capshelf never writes user-global `~/.pi/agent/extensions`.

Pi extensions execute arbitrary TypeScript with the user's permissions after
Pi trusts the project. Capshelf emits `pi_extension_executes_code` runtime
warnings on `add`, `share`, `promote`, `show`, and installed-item `status`, but
does not sandbox code or claim that it has been reviewed. Inspect all extension
source before materializing or promoting it.

Capshelf does not edit `.pi/settings.json`, manage Pi packages, write global
`~/.pi/agent/extensions`, install dependencies, or invoke a package manager.
A non-empty `package.json.dependencies` produces the advisory
`pi_extension_dependencies_not_installed` warning. Neither Pi warning makes
`status --strict` fail. After materialization, run `/reload` in Pi or restart
Pi; capshelf does not signal running Pi processes.

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
capshelf init --data ../capshelf-data                # requires a portable origin remote
capshelf init --claude-only --data ../capshelf-data  # real .claude/ skills only
capshelf init --data ../capshelf-data --upstream https://github.com/acme/capshelf-data
capshelf init --data ../capshelf-data --no-upstream  # intentionally local/non-portable
```

The selected layout is stored in `.capshelf/capshelf.json` as `installMode`. The data
repo path is stored in gitignored `.capshelf/local.json`. If the data repo has an
`origin` remote, `init` writes its normalized URL to `dataRepoUpstream` unless
`--no-upstream` is used; `--upstream <url>` overrides auto-detection only when
the local clone's `origin` already matches that URL. If capshelf cannot
determine a portable upstream, `init` fails before writing project state and
asks you to configure the data repo's `origin` or pass `--no-upstream`
explicitly.

A project is initialized on the current machine once `.capshelf/local.json`
exists. Re-running `init` in that state is refused with exit 3 before Capshelf
processes a replacement data repo, clones anything, reinstalls system items, or
rewrites metadata. Use `capshelf data bind`, `capshelf data upstream`, and
`capshelf update` for those explicit lifecycle changes. Changing the install
mode of an existing project is not an `init` operation and currently has no
automatic migration command.

Plain `capshelf init` also acts as fresh-clone onboarding when committed
`.capshelf/capshelf.json` exists but the gitignored `.capshelf/local.json` does
not. When the manifest declares `dataRepoUpstream`, Capshelf clones or reuses
that upstream at the default clone path, writes `.capshelf/local.json`, and
installs bundled system items. Run `capshelf apply` afterwards to materialize
the project's locked data items.

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
- `file://` URLs are accepted as bootstrap input only with `--no-upstream`
  (useful for local mirrors and testing). They are never recorded as
  `dataRepoUpstream`: a machine-local path is not a portable upstream, and
  `set-upstream` rejects `file://` URLs.
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
capshelf init
capshelf apply
```

That uses the committed `dataRepoUpstream` and the same default clone location
as `capshelf init --data <remote-url>`.

If you already cloned the data repo somewhere else, bind that local clone
explicitly:

```bash
git clone https://github.com/acme/capshelf-data ~/code/capshelf-data
capshelf set-data ~/code/capshelf-data
capshelf apply
```

`set-data` verifies the path is the root of a Git worktree, checks the clone's `origin` against
`dataRepoUpstream` when present, verifies existing data lock entries can be read
from the clone, writes `.capshelf/local.json`, and ensures
`.capshelf/.gitignore` contains that file.

Nested directories inside a worktree are not valid bindings. Paths containing
`..` or symlinked parent components are accepted only when their canonical
path is the worktree root.

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
  fix it manually, or migrate it directly with set-data:
    capshelf set-data <path-from-dataRepo>
  manual steps:
    1. remove dataRepo from <manifest-path>.
    2. point capshelf at that path:
         capshelf set-data <path-from-dataRepo>
    3. optionally declare the upstream (commits to .capshelf/capshelf.json):
         capshelf set-upstream <origin-url>
```

`capshelf set-data <path>` is the supported direct recovery command in this
state. It writes the portable manifest at `.capshelf/capshelf.json`, preserves
the remaining manifest fields, writes the local binding, and removes an
obsolete root `capshelf.json` only after validation succeeds.

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
| 2 | item or bundle not found in data repo |
| 3 | conflict or refused precondition (project is already initialized, a destructive `add`/`apply`/`update`/`rm`/`revert`/marketplace sync lacks consent, promote would clobber, a system or externally managed item was selected, an untracked target would be overwritten, a bundle failed preflight, or data sync cannot run safely) |
| 4 | drift detected (for `status --strict`), upstream verification failed, or `sync-data` needs human action (diverged history, or upstream commits blocked by a dirty worktree) |
| 5 | reserved for future unmet-requires checks (`add` with unmet `requires` warns and exits 0) |
| 6 | no data repo configured for this project (pass `--data`, set `.capshelf/local.json`, or `$CAPSHELF_HOME`) |
| 7 | required dependency missing (`git` not found on `PATH`) |

Initializing with no portable data repo origin:

```text
could not determine a portable data repo upstream.

  data repo: ../capshelf-data

capshelf records dataRepoUpstream so fresh clones know where shared items come from.

fix by one of:
  - configure the data repo's origin, then retry:
      git -C ../capshelf-data remote add origin <data-repo-url>
  - mark this project intentionally non-portable:
      capshelf init --data <path-or-url> --no-upstream
```

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

Missing binding without a declared upstream:

```text
no data repo configured for this project.

  pass --data <path>, or create .capshelf/local.json:
    mkdir -p .capshelf
    echo '{"dataRepo": "/path/to/clone"}' > .capshelf/local.json
  or set the env var for machine-wide default:
    export CAPSHELF_HOME=/path/to/clone

  if this is a cloned project, .capshelf/capshelf.json does not declare dataRepoUpstream,
  so capshelf cannot tell you which data repo to clone. Ask a maintainer
  for the data repo URL, then make it discoverable with:
    capshelf set-upstream <data-repo-url>
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

Copy-item promotion fails before changing the data repo when the installed
snapshot omits its required regular entrypoint (`SKILL.md` for a skill or
`index.ts` for a Pi extension). Project-scope snapshots contain only
Git-visible files, so an ignore rule covering the item must be removed or the
item must use local scope before it can be promoted. Capshelf also rechecks the
installed snapshot and copied content before committing; a concurrent edit
aborts and restores the canonical data-repo path and Git index.
Executable-mode-only edits count as local drift and are promotable changes.

### Destructive-change consent

`add`, `apply`, `update`, `rm`, `revert`, and Codex marketplace sync share one
preflight boundary. Before the first write, Capshelf plans the complete
operation and lists managed content drift, executable-mode changes, extra
local paths, subagent target drift, managed fragment drift, config-comment
loss, or dirty generated projection paths. Interactive human output asks once.
Declining exits 0 and writes nothing. JSON and other non-TTY runs refuse with
exit 3 unless `--yes` explicitly authorizes the listed loss. Capshelf
revalidates the accepted snapshot immediately before writing.

Use `capshelf status <item> --diff` to review managed item drift. Extra ignored
paths are listed directly because status deliberately filters them. Use
`capshelf marketplace sync --target codex --dry-run --json` for generated
projection changes. Dry runs report `destructiveChanges` and never prompt.

| Case | Result | Review or next command |
| --- | --- | --- |
| Clean locked content is applied, updated, removed, or already current | No prompt | Continue normally |
| Installed managed content or mode differs | Prompt; non-TTY/JSON exits 3 | `capshelf status <item> --diff`, then rerun with `--yes` if approved |
| Ignored local-only file survives reconciliation | Preserved without a prompt | Its path remains installed; a collision with new managed content hard-refuses |
| `rm` would delete an ignored or visible extra path | Prompt names the physical path | Preserve it elsewhere or rerun `rm ... --yes` |
| Fragment serialization would remove JSONC/TOML comments | Prompt names the output | Review the output and managed item diff before `--yes` |
| Codex projection is stale but Git-clean | Syncs normally | Review the resulting Git diff before committing |
| Codex projection has dirty affected paths | Prompt; dry-run lists paths | `capshelf marketplace sync --target codex --dry-run --json` |

Standalone `add` of an already-installed item does not reapply, repin, clear
`keep-local`, or select newer upstream content. Use `update` to select upstream,
`apply` or `revert` to restore the lock, and `status <item> --diff` before any
destructive choice.

### Stale-promote protection

`promote` refuses to overwrite data-repo content that is newer than this
project's lock (exit 3): if the item changed upstream since the project last
updated, the error shows the locked vs upstream shas, a scoped `git log` of
the upstream advance, and the safe choices: merge the two committed lines of
work with `capshelf promote <item> --merge`, take upstream with
`capshelf update <item>`, or overwrite on purpose with
`capshelf promote <item> --stale-ok`. `--merge` and `--stale-ok` are mutually
exclusive. The suggested commands preserve `--local` when the refusal came
from a local-scope promote. `update` warns and asks before replacing a drifted
installed copy; preserve the edit before consenting. Local-scope copy items
are excluded from the project's Git repository and cannot be recovered from
its diff.

`--merge` performs a standard Git three-way content merge from the locked
`sourceCommit`: base = locked content, local = the installed managed snapshot,
and upstream = the item at current data-repo HEAD. It is supported for
project- and local-scope skills and for project-scope Pi extensions. Local Pi
extensions, fragments, system items, missing or non-ancestral base history,
and a base tree that does not reproduce the lock are refused. A conflict lists
sorted item-relative paths and changes no data-repo, installed, manifest, or
lock state. On a clean result, capshelf makes at most one ordinary
single-parent data-repo commit and reconciles the calling project's installed
copy while preserving ignored/generated files outside its managed snapshot.
The root `.capshelf.yml` remains outside content identity; an installed
sidecar wins over upstream when the merged item is committed.

Two related behaviors:

- **Uncommitted data-repo edits inside the item's path always block** (exit
  3) and are *not* bypassable by `--stale-ok`: they have no commit
  provenance, so commit or discard them in the data repo first.
- **Convergence**: when the content being promoted is byte-identical to what
  upstream already has, promote succeeds without a commit, re-pins the lock
  to the upstream commit, and reports the action `"already-upstream"`.

`promote --json` notes: `action` may be `"already-upstream"` (consumers must
tolerate new action values), and `staleOverride: true` appears only when
`--stale-ok` actually bypassed a stale check (absent otherwise, including
when the flag was passed but nothing was stale). An actual successful
`--merge` adds `merged: true`, the full `mergeBase`, and the full
`mergedUpstreamCommit`; those fields are absent when `--merge` was supplied
but no stale merge was needed. If the merged tree already equals upstream,
capshelf creates no data commit, reconciles the installed copy, and persists
the new lock pin as one rollback-coordinated operation. Retrying after a
post-commit lock persistence failure converges without creating a second
content commit.

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

If `share` commits the source but local metadata persistence is interrupted,
rerun the documented `add` command in the intended scope. With no existing
lock, `add` adopts the canonical installed target only when its bytes and
executable modes exactly match the commit it would pin; a mismatch remains an
unmanaged-target conflict and writes no metadata.

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

## Viewing user-level skills

`capshelf ls` and `capshelf status` include a read-only inventory for skills
already installed at user runtime scope. `capshelf ls --user` and
`capshelf status --user` narrow the report to only that inventory. They scan:

| Surface | Directory |
|---|---|
| Claude | `~/.claude/skills/<name>/SKILL.md` |
| Codex | `~/.agents/skills/<name>/SKILL.md` |
| Codex | `$CODEX_HOME/skills/<name>/SKILL.md` or `~/.codex/skills/<name>/SKILL.md` |

Hidden directories are ignored. The human report splits Claude and Codex user
skills into separate sections because each runtime only loads its own user
paths. Default JSON output includes the flat `externalUserSkills` row array;
`ls --user --json` returns only that array, while `status --user --json`
returns the normal status envelope with only user inventory populated. When
the command runs from a capshelf project root, each row's `shadows` array names
any project or local capshelf skill with the same name. The command never
writes capshelf metadata and never adopts the user skill.

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
and bundles give it the discovery loop. Validation is a roadmap workflow
extension.

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
recursively. Two fragments that set the same scalar to *different* values are
refused (naming both fragments) rather than resolved silently by manifest
order; identical values and mergeable arrays/objects are fine. JSON outputs
(`settings.json`, `.mcp.json`) are read as JSONC (comments and trailing commas
tolerated), but a managed rewrite serializes plain JSON. JSONC and TOML comment
loss is detected during preflight and requires consent; dry-run and refusal
output name the affected config path. TOML date/time values are rejected in
fragment sources: capshelf's merge and hash pipeline round-trips values through
JSON, which cannot preserve TOML date types (a local date would silently become
a string or an offset date-time on re-emit).

Commands that reconcile multiple fragment outputs preflight every target
before writing any of them. If a later output swap fails, earlier swaps are
rolled back and lock changes are not persisted. TOML `inf`, `-inf`, and `nan`
are rejected before hashing or comparison because JSON canonicalization cannot
represent them distinctly.

`share` for fragments always lands in project scope (`--to project` is the
default; `--to local` is rejected). For mcp items the common case needs no
flags at all:

```bash
capshelf share mcp/github
```

This defaults the pick to the item name (`github`), scans both generated
outputs (`.mcp.json` and `.codex/config.toml`) for an unmanaged server with
that name, and adopts every output where it is found — both source files in a
single data-repo commit when the server exists in both. If neither output has
the server, the share fails and lists the unmanaged server names that are
available to pick.

Explicit forms remain for the other cases — an explicit source file
(`--from`, which for mcp requires `--target`), an item name that differs from
the server name (`--pick`), or restricting an mcp share to one output
(`--target`):

```bash
capshelf share settings/security --from ./settings.json
capshelf share mcp/github --target claude --from ./claude-mcp.json
capshelf share mcp/github --target codex --from ./codex-mcp.toml
capshelf share codex-config/defaults --from ./config.toml
```

`--pick <path>` (repeatable) extracts values that already live in the
generated output instead of requiring a separate source file. Only the
*unmanaged remainder* is eligible — the current output minus every locked
fragment's contribution — so picking a value that another fragment manages
fails and names the owning fragment. Extraction is deterministic because
unmanaged values have exactly one owner: the project. The output file is
unchanged by the share; the picked values simply become managed by the new
fragment. Settings and codex-config picks are dot-separated paths into the
output (and have no default, so they always require `--from` or `--pick`);
for mcp fragments a bare pick is sugar for a server name
(`mcpServers.<name>` for claude, `mcp_servers.<name>` for codex):

```bash
capshelf share settings/permissions --pick permissions.allow
capshelf share settings/security --pick permissions.deny --pick sandbox
capshelf share mcp/posthog-item --pick posthog            # item name ≠ server name
capshelf share mcp/github --pick github --target claude   # claude output only
capshelf share codex-config/defaults --pick model
```

`--pick` and `--from` are mutually exclusive, and `--pick` is rejected for
non-fragment items.

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
