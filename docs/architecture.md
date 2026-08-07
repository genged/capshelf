# Architecture

## Problem

Multiple repos accumulate their own `.claude/`, `.agents/`, `.pi/`,
`.mcp.json`, and `.codex/` config. Some is project-specific, some is generic. There's no clean
way to share it. Whole-directory symlink schemes are fragile, so capshelf keeps
real managed copies per project for copy items and reconciles shared JSON/TOML
fragments into project config outputs.

Requirements:
1. Share skills, Pi extensions, subagents, settings, and MCPs across repos from one or more user-owned **data repos**.
2. Updates can stay local or be pushed up to the data repo.
3. A change to a data repo **must not** disturb in-flight PRs on other projects.
4. Some items are generic, some are project-specific. Both must coexist.
5. The CLI is a generic tool — installed once, usable against any data repo.

## Shape

```
   ┌─────────────────────┐         ┌────────────────────────┐
   │ capshelf binary   │         │ ~/code/work-skills/    │   data repo (git)
   │ (installed once at  │ ──uses─►│   skills/              │
   │  ~/.local/bin/)     │         │   settings/ mcp/ ...   │
   │ + bundled system    │         └────────────────────────┘
   │   items (bootstrap  │
   │   skill, etc.)      │         ┌────────────────────────┐
   └──────────┬──────────┘ ──uses─►│ ~/code/personal-stuff/ │   another data repo
              │                    │   skills/ ...          │
              │                    └────────────────────────┘
              ▼
       ┌──────────┐ ┌──────────┐ ┌──────────┐
       │ proj-A   │ │ proj-B   │ │ proj-C   │
       │ .capshelf│ │ .capshelf│ │ .capshelf│
       │ .agents/ │ │ .agents/ │ │ .agents/ │
       └──────────┘ └──────────┘ └──────────┘
              ▲
              │  share/promote <item>
              └─────────► the data repo this project is bound to
```

Each project binds to **exactly one** data repo. Portable project intent is recorded in `.capshelf/capshelf.json`; the machine-specific clone path and clone-local item intent live in `.capshelf/local.json`, which is ignored by `.capshelf/.gitignore`. The binary is shared by all projects. Each project pins committed managed items to a content hash + source commit in `.capshelf/capshelf.lock.json`; clone-local pins live in `.capshelf/local.lock.json`. Default-mode `.claude/skills/<name>` symlinks point at the real `.agents/skills/<name>` managed directories; data-repo updates don't propagate until a project runs `capshelf update`.

## Mental model: declarative reconciler, not an installer

Two camps of tools manage on-disk state from a manifest:

| | imperative installers | declarative reconcilers |
|---|---|---|
| examples | `npm install`, `pnpm install`, `cargo install`, `apt install` | `terraform apply`, `kubectl apply`, `nix-env`, `ansible-playbook` |
| verb shape | "fetch this, put it there" | "converge on-disk state to match the spec" |
| drift | a bug — mutated artifacts get wiped on next run | a first-class state — diffed against the spec, surfaced to the user |
| user edits to outputs | unsupported / discouraged | expected; the loop is edit → reconcile back |

capshelf lives firmly in the second camp. The lock is the spec, `apply` is the reconciler, `status` is the plan. This is why drift is reported rather than silently overwritten, why `keep-local` exists, and why the round-trip verb is `promote` rather than `publish` — you're moving an edited piece of state back into the source of truth, not shipping a new artifact.

Verbs map to this model:

- **`apply`** — converge project files and generated config outputs to match manifest + lock after destructive-change preflight.
- **`add`** — add a new data-repo item to the spec and materialize it; an already-installed item is a stable no-op.
- **`status`** — show the diff between desired (lock) and actual project files. Read-only.
- **`update`** — bump the spec (lock pointer → data repo HEAD), then apply.
- **`revert`** — discard local edits to one item by reapplying its locked content.
- **`share`** — adopt not-yet-shared on-disk content into the data repo, then track it in local or project scope.
- **`move`** — change an already-tracked item's scope between local and project metadata without changing data-repo content.
- **`promote`** — flow edits for an already-tracked item the other direction: project → data repo, then update the spec.
- **`keep-local`** — explicitly mark an item as intentionally diverged so reconciliation tolerates the drift.

Naming `apply` rather than `install` is deliberate: the verb describes *converging to a spec*, not *fetching a package*. Documentation, `--help`, and error messages should reinforce this framing.

## Two kinds of items

| origin | source of truth | examples | promotable? |
|---|---|---|---|
| **system** | bundled in the CLI binary | bootstrap `capshelf` skill, future built-ins | no — submit a PR to the capshelf repo |
| **data** | a user-owned data repo (git) | user skills, Pi extensions, settings/MCP fragments, Codex config fragments | yes — `share` and `promote` commit to the data repo |

Both kinds live in the same lockfile but with different entry schemas (see Lock below).

## Data repo layout

A data repo is any directory matching this layout, with its own git history:

```
~/code/<your-data-repo>/
├── skills/                     copy-whole-dir items
│   └── <name>/
│       ├── SKILL.md
│       └── assets/…
├── pi/
│   └── extensions/             project-local Pi extension copy items
│       └── <name>/
│           ├── index.ts        required entry point
│           └── src/…
├── subagents/
│   └── <name>/
│       ├── claude.md           (→ .claude/agents/<name>.md)
│       └── codex.toml          (→ .codex/agents/<name>.toml)
├── settings/                   mergeable fragments (→ settings.json)
│   └── <name>/
│       └── settings.json
├── mcp/                        mergeable Claude/Codex MCP fragments
│   └── <name>/
│       ├── claude.json         (→ <project>/.mcp.json)
│       └── codex.toml          (→ <project>/.codex/config.toml)
├── codex/
│   ├── config/
│   │   └── <name>/
│   │       └── config.toml     (→ <project>/.codex/config.toml)
│   ├── plugin-definitions/     authored Codex plugin composition
│   └── generated/              committed native Codex plugin projection
├── .claude-plugin/
│   └── marketplace.json        authored Claude marketplace
├── .agents/plugins/
│   └── marketplace.json        generated native Codex marketplace
├── bundles/                    optional named item sets (manifest macros)
│   └── <name>.yml
└── .git/                       required: a data repo MUST be a git repo
```

The bound directory must canonicalize to the Git worktree root; a nested
directory is not a data repo binding. Copy-item trees contain regular files
only. Working-tree ingestion rejects symlinks and special objects, and
commit-based reads accept only blob modes `100644` and `100755`.

Items may carry an optional `.capshelf.yml` metadata sidecar at their
directory root (see Item Metadata below). The CLI discovers installable
items only from `skills/`, `pi/extensions/`, `subagents/`, `settings/`, `mcp/`, and
`codex/config/`; `bundles/*.yml` files are catalog data, not items (see Bundles below).

Multiple data repos can coexist on a single machine. Projects pick one in their manifest.

## CLI source repo

The capshelf source repository contains:

```
<capshelf-source>/
├── src/
│   ├── bundled/                    bundled system items compiled into the binary
│   │   └── skills/capshelf/SKILL.md
│   ├── cli.ts
│   ├── git.ts                      git wrapper module
│   └── …
├── dist/                           built binary (gitignored)
├── package.json
├── Makefile
├── docs/                           this folder
└── .git/
```

**Code only** — no `skills/`, `settings/`, `mcp/`, etc. at the top level. Data lives in a separate directory.

## Smoke-test data repo

The source repo's smoke tests need *some* data repo to point at. A common local
fixture is `~/code/capshelf-data/`:

```
~/code/capshelf-data/
├── skills/
│   └── hello/SKILL.md            smoke-test dummy
└── .git/
```

There is no implicit default. The `Makefile`'s smoke targets each create their own temporary data repo so regression tests do not depend on this fixture. For day-to-day dev, set `CAPSHELF_HOME=~/code/capshelf-data` in your shell so `init` doesn't need `--data` every time.

A real user creates their own data repos (`~/code/work-skills/`, `~/code/personal-skills/`, etc.) — `capshelf-data` is just the test fixture for this codebase.

## Per-project files

```
<project>/
├── .capshelf/
│   ├── .gitignore            contains local.json and local.lock.json
│   ├── capshelf.json         committed manifest: install mode, items, optional dataRepoUpstream
│   ├── local.json            gitignored binding plus clone-local copy-item intent
│   ├── capshelf.lock.json    committed lock: pinned sha + sourceCommit, tool-managed
│   └── local.lock.json       gitignored lock for local-only items
├── .agents/skills/<name>/      default real skill directories
├── .claude/skills/<name>       default per-skill symlink to .agents/skills/<name>
├── .pi/extensions/<name>/      project-local Pi extension directories
├── .claude/settings.json       Claude settings output, with local values preserved
├── .mcp.json                   Claude shared project MCP output
└── .codex/config.toml          Codex project config output
```

`capshelf init --claude-only` stores real skill directories directly under `.claude/skills/<name>/` and does not create `.agents` compatibility symlinks.

Project commands can be run from the project root — the directory containing
`.capshelf/capshelf.json` — or any subdirectory of it: capshelf walks upward to
find the nearest project root, like git/npm/cargo. It does not fall back to Git
roots. `init` acts on the current directory (no upward discovery), so it creates
`.capshelf/` exactly where it is run.

Manifest:
```json
{
  "installMode": "codex-compatible",
  "dataRepoUpstream": "https://github.com/acme/work-skills",
  "skills":   ["security-review"],
  "settings": [],
  "mcp":      [],
  "codexConfig": [],
  "piExtensions": [],
  "subagents": []
}
```

Local manifest:
```json
{
  "dataRepo": "~/code/work-skills",
  "skills": [],
  "piExtensions": [],
  "settings": [],
  "mcp": []
}
```

Local scope is available to copy-directory items: skills and Pi extensions.
Subagents are project-scope only.
Fragment kinds preserve project-local values inside generated outputs instead
of using clone-local manifest entries. In Git projects, local-scope copy items
add their install paths to `.git/info/exclude`; non-Git projects skip that step
because local ownership is already recorded in `.capshelf/local.json` and
`.capshelf/local.lock.json`.

`dataRepo` resolution order:
1. `--data <path>` CLI flag (one-shot override)
2. `dataRepo` field in `.capshelf/local.json`
3. `$CAPSHELF_HOME` env var
4. fail with a clear message

`.capshelf/capshelf.json` must not store per-machine absolute paths.
`.capshelf/local.json` is written by `init` and `set-data`, and those
commands ensure it appears in `.capshelf/.gitignore`.

When `dataRepoUpstream` is present, capshelf verifies that the resolved local
clone's `origin` remote normalizes to the same URL before using the data repo.
This check runs for `set-data`, `.capshelf/local.json`, `--data`, and env-var
bindings. Capshelf does not fetch or clone; if a lock `sourceCommit` is missing,
the user has either pointed at the wrong clone, needs to fetch, or has a data
repo whose history was rewritten.

Remote URL normalization is intentionally git-specific. Supported forms such as
`git@github.com:org/repo.git`, `ssh://git@github.com/org/repo`,
`https://token@github.com/org/repo.git`, `github:org/repo`, and mixed-case
scheme/host URLs all canonicalize to `https://github.com/org/repo`. The scheme
and host are lowercased, credentials and one trailing `.git` are stripped, and
path case is preserved.

## Lock schema (v3)

Each entry is a discriminated union on `source`:

```ts
data:   { source: "data",   sha, sourceCommit, needs, needsSourceCommit, appliedAt, label? }
system: { source: "system", sha, cliVersion,   appliedAt }
```

Lock keys are prefixed, for example `data/skills/<name>`,
`data/pi-extensions/<name>`, `data/settings/<name>`, `data/mcp/<name>`,
`data/codex-config/<name>`, `data/subagents/<name>`, or
`system/skills/<name>`. This avoids collisions and makes the source obvious.

- `sha` — content hash (identity).
- `sourceCommit` — for data items, the **last-touching commit** in the data repo (`git log -1 --format=%H -- <path>`). Fragment items use only canonical source files such as `settings/<name>/settings.json`, `mcp/<name>/claude.json`, `mcp/<name>/codex.toml`, and `codex/config/<name>/config.toml`. Subagents watch both canonical target pathspecs so a target deletion is pinned while metadata-only commits remain invisible. Lets `apply`/`revert` retrieve historical content via `git show <commit>:<path>` even if the data repo's HEAD has moved past the locked version.
- `needs` / `needsSourceCommit` — a normalized snapshot of the item's declared
  runtime requirements and the data-repo commit it came from. This provenance
  is independent of the sidecar-blind content pin. Version 2 locks load with
  both fields set to `null` (unknown) and are written as version 3 only by a
  command already authorized to save the lock.
- `cliVersion` — for system items, the capshelf binary version that wrote the entry. Drives "update available" detection when the binary upgrades.

CLI-only changes in the data repo (e.g. someone edits `src/foo.ts`) don't bump `sourceCommit` for unaffected data items — `lastTouchingCommit` is path-scoped.

## Apply strategies

| kind | strategy | output |
|---|---|---|
| skills | copy whole directory | default: `.agents/skills/<name>/` plus `.claude/skills/<name>` symlink; `--claude-only`: `.claude/skills/<name>/` |
| pi-extensions | copy whole directory | `.pi/extensions/<name>/`; requires `index.ts`, no aliases or settings edits |
| subagents | copy every present canonical target file | `.claude/agents/<name>.md` and/or `.codex/agents/<name>.toml` |
| settings | merge `settings/<name>/settings.json` fragments in manifest order | `.claude/settings.json` |
| mcp | merge `mcp/<name>/claude.json` and/or `mcp/<name>/codex.toml` fragments | `.mcp.json` and/or `.codex/config.toml` |
| codex-config | merge `codex/config/<name>/config.toml` fragments | `.codex/config.toml` |

Apply and revert build a complete replacement copy-item tree in a temporary
sibling directory, verify its bytes and modes, then publish it with renames.
The previous installation remains available as a backup through alias
creation; a read, write, chmod, publication, or alias failure restores it.

Pi extensions are loaded by Pi only after project trust. Project and
clone-local Capshelf scope both materialize to the same Pi project path;
Capshelf scope controls intent and lock ownership, not Pi runtime scope.
Capshelf does not sandbox their arbitrary TypeScript execution, install
`package.json` dependencies, edit `.pi/settings.json`, or signal a running Pi
process. Review source before adding or promoting an extension, then run
`/reload` or restart Pi after materialization.

### Destructive reconciliation boundary

The lock defines reproducible managed state, but installed trees and generated
outputs may also contain unique local state. Before `add`, `apply`, `update`,
`rm`, `revert`, or Codex marketplace sync overwrites that state, a shared
planner completes the full read-only operation, emits deterministic typed
change records, asks once, and revalidates the reviewed snapshot before the
first write. JSON and non-TTY invocations require `--yes`; dry runs report the
same plan without prompting. `--yes` authorizes only enumerated loss and never
bypasses hard path, source, collision, or transaction checks.

Copy-item reconciliation carries forward ignored local-only files that do not
collide with selected managed paths. Removal inventories the complete physical
tree, including ignored files. Fragment planning preserves unmanaged values and
separately identifies managed contribution drift and JSONC/TOML comment loss.
Missing managed content is reproducible and safe to recreate.

### The object model

Git visibility is the line between drift and local state. Every call site that
walks a managed directory classifies what it finds against these five rows;
the same table is repeated in `src/master.ts` next to the sidecar invariant.

| # | Population | Policy |
|---|---|---|
| 1 | Item content in the data-repo working tree | Regular files only, Git modes. Symlinks refused — trust boundary |
| 2 | Item content at a commit | Regular blobs only, sidecar filtered |
| 3 | Git-visible content inside an installed directory that is not managed | Drift. Reconciled away under consent as `extra_local_path`; Git modes apply, so `executable_mode` is a real change |
| 4 | Ignored local state under an installed directory | Carried across as-is: real `stat` modes, symlinks preserved by target, never hashed or published. Non-recreatable objects (fifo, socket, device) refused on write, listed on remove |
| 5 | `.capshelf.yml` | Excluded from hashing and materialization everywhere; for reconciliation, treated as row 4 regardless of Git visibility |

Rows 1 and 2 are the trust boundary: item content crossing into or out of the
data repo is Git's object model, and nothing below may widen it. Row 4 never
crosses that boundary — an ignored `node_modules/.bin/*` symlink or an
owner-only `.env.local` came from the user's filesystem and goes back to the
same path, so capshelf never dereferences, hashes, or publishes it, and Git's
two-mode model does not apply to it.

Claude custom commands are represented as skills. In the default layout, a skill at `.agents/skills/<name>/SKILL.md` is exposed to Claude through `.claude/skills/<name>`. In Claude-only layout, the skill lives directly at `.claude/skills/<name>/SKILL.md`. capshelf does not manage `.claude/commands/`.

### Merge rules

Deterministic, boring:

| shape | strategy |
|---|---|
| objects/tables | recursive merge |
| arrays | concat in manifest order with deterministic dedupe |
| scalars | identical across fragments merges; a genuine conflict is refused |

The existing generated output is the local base. On `add`, `apply`, `update`,
`rm`, and `revert`, capshelf removes the old managed contribution, keeps local
values that were not contributed by the old fragment set, then merges the newly
locked managed contribution on top. It refuses unmanaged scalar or shape
collisions instead of overwriting project-local values, and refuses two
fragments that set the same key to conflicting scalar values instead of
resolving them silently by manifest order.

Multi-target reconciliation separates planning from publication: every
fragment target must pass collision and current-output checks before the first
write. Publication retains the old text for rollback, and lock state advances
only after all target writes succeed. Configuration maps use own data
properties throughout merge and serialization so valid keys such as
`__proto__` and `constructor` are not lost or mistaken for inherited values.

## Versioning: content-hash + last-touching-commit

- Each item has a `sha` over its sorted file list. Truncated `sha256`, 12 hex chars.
- Copy-item executable mode is compared separately as normalized Git mode
  `100644` or `100755`; it is intentionally not folded into the current hash
  format.
- For data items, the lockfile also records `sourceCommit` — the data repo commit whose tree at this item's path matches the locked sha.
- For system items, the lockfile records `cliVersion` — the capshelf binary version that produced the bundled content.
- Optional human `label` (e.g. `"v3"`) is decoration, not identity.

## Parallel-PR safety

Three rules together guarantee that an edit in one project never disturbs another:

1. **Per-project materialization.** Project A's real managed files are frozen at the sha in its lock. Default-mode `.claude/skills/<name>` symlinks are only local compatibility surfaces for those same files.
2. **Data-repo writes only touch the calling project's metadata.** When A promotes, only A's lock bumps to the new `sourceCommit`; when A shares, only A records the new item.
3. **`update` is opt-in per-project.** Other projects remain pinned to their old sha; their `status` reports "update available" but files don't change.

Network sync is equally explicit: only `sync-data` fetches the data repo's
`origin`, and the only branch mutation it ever performs is a provably safe
fast-forward (diverged, dirty, and detached states stop with git guidance).
In the other direction, `promote` refuses to overwrite data-repo content
newer than the calling project's lock — a stale promote is a conflict (exit
3) resolved by an explicit three-way `--merge` for supported copy items or
bypassed by an intentional `--stale-ok`; the flags are mutually exclusive.
Uncommitted data-repo edits under the item's path always block.

The merge engine reconstructs raw-byte trees and executable modes for the
locked base, installed local snapshot, and current upstream commit, then runs
standard Git merge behavior in a disposable synthetic repository. That
process receives no inherited system/global Git configuration, templates,
hooks, filters, merge drivers, fsmonitor, or signing commands. Before writing,
promote revalidates data-repo HEAD and cleanliness plus the local snapshot and
sidecar. Conflicts are read-only. A clean content result is installed through
a path transaction and committed by a conditional HEAD update with an
alternate index, producing at most one normal single-parent commit; a
pre-commit failure restores the exact item path and index. Other projects'
files and locks remain pinned until their own `update`.

See `docs/team-workflow.md` for the team loop built on these guarantees.

## Local overrides: two escape hatches

1. **Project-local settings values** — values already present in `.claude/settings.json` and not contributed by a locked settings fragment are preserved when a fragment is added, applied, removed, or updated.
2. **Local-only files in managed copy trees** — ignored regular files are
   preserved across reconciliation when they do not collide with selected
   managed paths. Visible extras that replacement would remove require
   consent; `rm` inventories both visible and ignored extras. Separate
   unlocked item directories remain outside Capshelf ownership and can later
   be adopted with `share`.

## Coexistence with peer tools

`skills.sh` can manage read-only third-party skills and records them in `<project>/skills-lock.json`. In Claude projects those skills appear in `.claude/skills/`; in Codex-style projects skills.sh stores them in `.agents/skills/` and creates one symlink per skill into `.claude/skills/`. capshelf reads `skills-lock.json` only to avoid co-managing the same path, and follows `.claude/skills/<name>` symlinks to the real managed directory when a skill is capshelf-owned.

| population | source of truth | editability | tracked by |
|---|---|---|---|
| user-owned | data repo | share + edit + promote | `.capshelf/capshelf.lock.json` or `.capshelf/local.lock.json` |
| 3rd-party | github via skills.sh | read-only | `skills-lock.json` |
| Claude plugins | Claude plugin marketplaces/settings | read-only | Claude `enabledPlugins` settings |
| project-only | this project | edit freely | nothing |

When a skill name is present in `skills-lock.json`, capshelf `add`, `share`, `rm`, `revert`, and `promote` reject that path; bulk `apply` and `update` skip it; `status` shows it under `external/` and does not trip `--strict`.

Claude Code marketplace plugins are also treated as external. Capshelf reads
`enabledPlugins` from managed, user, project, and local Claude settings and
reports them in `status`, but it does not edit those settings or touch
`~/.claude/plugins/cache`.

Claude personal skills under `~/.claude/skills/<name>` are outside project
ownership but can shadow project-managed skills at runtime. Capshelf treats
that as a warning, not a filesystem conflict: materializing commands surface
`shadowed_by_personal_claude_skill`, `status` includes the warning in human and
JSON output, `status` lists the personal skill under
`external/  (Personal Claude)`, and `status --strict` exits 4 until the personal
skill is removed or renamed.

`ls` and `status` include a broader read-only inventory of user-level runtime
skills in `~/.claude/skills`, `~/.agents/skills`, and `$CODEX_HOME/skills` (or
`~/.codex/skills`) by default; `--user` narrows either command to only that
inventory. Human output groups Claude and Codex user skills separately because
the runtimes do not load each other's user paths. These rows are external
inventory, not managed state: capshelf does not write user-scope metadata,
adopt the skills, or reconcile them. When run from a project root, the
inventory reports whether a user skill shadows a project or clone-local
capshelf skill.

## Item Metadata

Items carry catalog metadata from two sources:

1. An optional `.capshelf.yml` sidecar at the **item directory root** in the
   data repo (`skills/<name>/.capshelf.yml`,
   `pi/extensions/<name>/.capshelf.yml`, `codex/config/<name>/.capshelf.yml`,
   …), for all six kinds:

   ```yaml
   description: Deep multi-pass security audit of changed files.
   tags: [security, review]
   requires: [settings/permissions-base]
   conflicts-with: [skills/quick-review]
   needs:
     network: [api.example.com]
     env: [EXAMPLE_TOKEN]
     bin: [example-cli]
   ```

   Unknown fields (e.g. a future `targets`) are ignored for forward
   compatibility; malformed metadata warns on stderr and degrades to
   no-metadata — it never blocks reading or installing content.

2. SKILL.md YAML frontmatter (skills only), read for a fallback
   `description`. The merge is per-field with the sidecar winning;
   `tags`/`requires`/`conflicts-with`/`needs` are sidecar-only.

   The sidecar keeps its own `description` field despite the overlap:
   fragment kinds have no frontmatter (one schema covers all kinds), the
   two surfaces have different change costs (frontmatter is delivered and
   hashed, so editing it is content drift; a sidecar edit is drift-free),
   and they address different readers (frontmatter is Claude's runtime
   invocation trigger, the sidecar is catalog copy for shelf browsers).
   Skills with good frontmatter need no sidecar `description` at all.

This metadata feeds `ls` (descriptions, `#tags`, `--tag` filtering),
`show` (relations with install state), `search`, and `add` enforcement
(`requires` warns and exits 0; `conflicts-with` refuses symmetrically with
exit 3 and no force flag).

**The sidecar is not item content.** The lock pins what the agent runtime
sees, and the sidecar is never delivered: it is excluded from every hashing
path and from materialization, so a tag or description edit never flashes a
content update across consuming projects. Declared `needs` are the exception
to live-only catalog metadata: the selected declaration is lock-pinned, and
`status` reports requirements freshness separately from content state. A
needs-only `update` changes the lock without rewriting installed bytes. The deliberate asymmetry: a
description edit in SKILL.md frontmatter *does* bump the sha, because
frontmatter ships to Claude and genuinely changes runtime behavior — hashed
iff delivered. `promote` and `share` cache and restore the data-repo sidecar
around their directory replaces so promoting content never deletes upstream
metadata.

`sourceCommit` is sidecar-blind too: copy-item pins are computed by
`lastTouchingContentCommit` (`git log -1` with a
`:(exclude)<item>/.capshelf.yml` pathspec, falling back to the unfiltered
commit for sidecar-only histories), so ordinary catalog-only data-repo
changes leave `update` a true no-op. A changed `needs` declaration refreshes
`needs` and `needsSourceCommit` without moving this content pin. Fragment
items are immune by construction: their `sourceCommit` is computed from
canonical source paths only. `ls`/`show`/`search` read metadata from the
data repo **working tree** — a catalog view of the shelf as it is now, not a
pinned view per `sourceCommit`.

## Declared needs

Every item kind may declare normalized `network`, `env`, and `bin` needs in
its sidecar. `add`, bundle expansion, `update`, `share`, and `promote` capture
the committed declaration in the selected lock; `apply`, `revert`, `move`,
and `keep-local` preserve it.

Capshelf displays declarations and reports their lock freshness, but does not
probe the host, inspect an external runtime's configuration, enforce access,
or satisfy requirements. Runtime policy and environment state remain owned by
the runtime in which the item executes.

## Bundles

A bundle is a **manifest macro, not a versioning unit**: `capshelf add
bundles/<name>` expands a named set into the project manifest, and after
expansion every member is locked independently — exactly as if it had been
added one `capshelf add` at a time.

```yaml
# bundles/go-backend.yml
description: Everything a Go backend service needs.
tags: [go, backend]
includes:
  skills:   [security-review, go-test-writer]
  settings: [permissions-base, permissions-go]
  mcp:      [github, postgres-local]
```

Properties of the implemented model:

- **Traceless.** A bundle has no lock entry, no sha, no project-side state.
  `status`, `update`, `rm`, and `promote` see only items; the bundle name is
  echoed only in `add` output (human and `--json`) for the agent's commit
  message. The bundle file itself is never hashed, pinned, or materialized —
  it is read fresh from the data repo working tree (and may be uncommitted),
  while member items still go through the standard clean-path checks.
- **All-or-nothing preflight.** Every deterministic refusal — missing
  members, symmetric `conflicts-with` (vs installed items and vs sibling
  members), cross-scope ownership, untracked targets, dirty data-repo paths,
  and fragment unmanaged collisions (via a dry-run merge plan against the
  full post-bundle fragment set) — is caught read-only before any write. A
  failure yields a per-member report, zero writes, exit 3. Manifest and lock
  are persisted after each member during install, so the one failure
  preflight cannot rule out (mid-install I/O) leaves a consistent prefix
  that a re-run converges past.
- **Skip already-installed members.** Re-running either bundle or standalone
  add never re-applies or pin-bumps installed items. Re-run is both the
  recovery path and the upgrade path after the team grows the bundle.
- **Flat composition.** Bundles cannot include bundles; `show
  bundles/<name>` always displays the complete literal member list with
  per-member availability and install state.
- **Discovery.** `ls` appends a `bundles/` section, `search` ranks bundles
  alongside items (member refs score as content), and all bundle JSON
  surfaces are append-only sibling keys.

## Codex parity

Same model, different output paths. Codex items live under `codex/` in a data repo. A single project manifest can mix Claude and Codex items. One lockfile, one `apply`, both toolchains stay in sync.

## Plugin marketplaces

Marketplace definitions are data-repo catalog state, not Capshelf items.
They never appear in a project manifest or lock and are never materialized
into a consuming project.

Claude composition is authored directly in the official
`.claude-plugin/marketplace.json`. Capshelf-managed entries are skill-only
root sources (`source: "./"`, `strict: false`) with explicit canonical skill
paths. Malformed attempted-managed entries are invalid; versioned,
remote-source, and mixed-component entries are preserved as external state.

Codex composition is authored in `codex/plugin-definitions/`. Capshelf
projects it into `.agents/plugins/marketplace.json` and self-contained regular
file copies under `codex/generated/plugins/`. The generated tree is committed
so the data repo can be registered directly with
`codex plugin marketplace add <data-repo>`. `marketplace sync --target codex`
repairs clean derived drift and never stages or commits. Dirty affected paths
inside the owned projection roots require consent and are reported by dry-run.
Marketplace mutations and Capshelf skill share/promote commits update
the projection in the same local Git commit.

Package outputs are disposable. Claude packages are deterministic root-content
ZIP `.plugin` files; detached Codex packages are one-plugin marketplace
directories. Capshelf stops at the runtime boundary: it does not push,
register, install, enable, refresh, or inspect plugin caches.

Marketplace source, selected-skill, generated, and package paths are checked
component-by-component for symlink ancestors before reads, deletion, or
writes. Package containment compares resolved real paths through the nearest
existing ancestor. Logical hashes recursively sort JSON object keys, preserve
array order, and use Git executable intent for tracked files, so unrelated
commits, host chmod drift, and object-key ordering do not rotate cachebusters.

Canonical skill identity is independent of plugin identity. When renaming a
skill directly in the data repo, rename its directory and update every Claude
and Codex membership in the same Git change, then sync and validate. A skill
cannot be deleted while any plugin still selects it: validation, sync,
packaging, and marketplace mutations all refuse the dangling reference.

## What the human does (and doesn't)

Humans approve data-repo writes and glance at `status` when starting a project.
Agents handle the current CLI workflow — discover (`search`, `ls --tag`,
`show bundles/<name>`), inspect, edit, share, move, promote, and reconcile —
via the CLI surface in `cli.md`. Validation is a roadmap workflow.
