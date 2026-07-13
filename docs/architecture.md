# Architecture

## Problem

Multiple repos accumulate their own `.claude/`, `.agents/`, `.mcp.json`, and
`.codex/` config. Some is project-specific, some is generic. There's no clean
way to share it. Whole-directory symlink schemes are fragile, so capshelf keeps
real managed copies per project for copy items and reconciles shared JSON/TOML
fragments into project config outputs.

Requirements:
1. Share skills/settings/MCPs across repos from one or more user-owned **data repos**.
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

- **`apply`** — converge project files and generated config outputs to match manifest + lock. Idempotent, safe to run anytime.
- **`add`** — add a data-repo item to the spec and materialize it, but only if the target path is absent or already locked.
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
| **data** | a user-owned data repo (git) | user skills, settings/MCP fragments, Codex config fragments | yes — `share` and `promote` commit to the data repo |

Both kinds live in the same lockfile but with different entry schemas (see Lock below).

## Data repo layout

A data repo is any directory matching this layout, with its own git history:

```
~/code/<your-data-repo>/
├── skills/                     copy-whole-dir items
│   └── <name>/
│       ├── SKILL.md
│       └── assets/…
├── settings/                   mergeable fragments (→ settings.json)
│   └── <name>/
│       └── settings.json
├── mcp/                        mergeable Claude/Codex MCP fragments
│   └── <name>/
│       ├── claude.json         (→ <project>/.mcp.json)
│       └── codex.toml          (→ <project>/.codex/config.toml)
├── codex/
│   └── config/
│       └── <name>/
│           └── config.toml     (→ <project>/.codex/config.toml)
├── bundles/                    optional named item sets (manifest macros)
│   └── <name>.yml
└── .git/                       required: a data repo MUST be a git repo
```

Items may carry an optional `.capshelf.yml` metadata sidecar at their
directory root (see Item Metadata below). The CLI discovers installable
items only from `skills/`, `settings/`, `mcp/`, and `codex/config/`;
`bundles/*.yml` files are catalog data, not items (see Bundles below).

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
│   ├── local.json            gitignored local binding plus local skill intent
│   ├── capshelf.lock.json    committed lock: pinned sha + sourceCommit, tool-managed
│   └── local.lock.json       gitignored lock for local-only items
├── .agents/skills/<name>/      default real skill directories
├── .claude/skills/<name>       default per-skill symlink to .agents/skills/<name>
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
  "codexConfig": []
}
```

Local manifest:
```json
{
  "dataRepo": "~/code/work-skills",
  "skills": [],
  "settings": [],
  "mcp": []
}
```

Local scope is skills-only in current behavior. Fragment kinds preserve
project-local values inside generated outputs instead of using clone-local
manifest entries.
In Git projects, local-scope skills add their install paths to
`.git/info/exclude`; non-Git projects skip that step because local ownership is
already recorded in `.capshelf/local.json` and `.capshelf/local.lock.json`.

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

## Lock schema (v2)

Each entry is a discriminated union on `source`:

```ts
data:   { source: "data",   sha, sourceCommit, appliedAt, label? }
system: { source: "system", sha, cliVersion,   appliedAt }
```

Lock keys are prefixed, for example `data/skills/<name>`,
`data/settings/<name>`, `data/mcp/<name>`, `data/codex-config/<name>`, or
`system/skills/<name>`. This avoids collisions and makes the source obvious.

- `sha` — content hash (identity).
- `sourceCommit` — for data items, the **last-touching commit** in the data repo (`git log -1 --format=%H -- <path>`). Fragment items use only canonical source files such as `settings/<name>/settings.json`, `mcp/<name>/claude.json`, `mcp/<name>/codex.toml`, and `codex/config/<name>/config.toml`. Lets `apply`/`revert` retrieve historical content via `git show <commit>:<path>` even if the data repo's HEAD has moved past the locked version.
- `cliVersion` — for system items, the capshelf binary version that wrote the entry. Drives "update available" detection when the binary upgrades.

CLI-only changes in the data repo (e.g. someone edits `src/foo.ts`) don't bump `sourceCommit` for unaffected data items — `lastTouchingCommit` is path-scoped.

## Two apply strategies

| kind | strategy | output |
|---|---|---|
| skills | copy whole directory | default: `.agents/skills/<name>/` plus `.claude/skills/<name>` symlink; `--claude-only`: `.claude/skills/<name>/` |
| settings | merge `settings/<name>/settings.json` fragments in manifest order | `.claude/settings.json` |
| mcp | merge `mcp/<name>/claude.json` and/or `mcp/<name>/codex.toml` fragments | `.mcp.json` and/or `.codex/config.toml` |
| codex-config | merge `codex/config/<name>/config.toml` fragments | `.codex/config.toml` |
| codex/agents | planned copy whole file | `<project>/.codex/agents/<name>.toml` or `~/.codex/agents/` |

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

## Versioning: content-hash + last-touching-commit

- Each item has a `sha` over its sorted file list. Truncated `sha256`, 12 hex chars.
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
3) bypassed only by an explicit `--stale-ok`, and uncommitted data-repo edits
under the item's path always block. See `docs/team-workflow.md` for the team
loop built on these guarantees.

## Local overrides: two escape hatches

1. **Project-local settings values** — values already present in `.claude/settings.json` and not contributed by a locked settings fragment are preserved when a fragment is added, applied, removed, or updated.
2. **Untracked files in agent surfaces** — anything not listed in the lock is ignored by the tool forever. In the default layout, project-only skills should live in `.agents/skills/<name>/` if they may later be adopted with `share`; `.claude/skills/<name>` is just the compatibility symlink. `init`, `add`, and `rm` all treat the lock as the ownership boundary.

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
   `codex/config/<name>/.capshelf.yml`, …), for all four kinds:

   ```yaml
   description: Deep multi-pass security audit of changed files.
   tags: [security, review]
   requires: [settings/permissions-base]
   conflicts-with: [skills/quick-review]
   ```

   Unknown fields (e.g. a future `targets`) are ignored for forward
   compatibility; malformed metadata warns on stderr and degrades to
   no-metadata — it never blocks reading or installing content.

2. SKILL.md YAML frontmatter (skills only), read for a fallback
   `description`. The merge is per-field with the sidecar winning;
   `tags`/`requires`/`conflicts-with` are sidecar-only.

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
path and from materialization, so a tag or description edit never flashes
"update available" across consuming projects. The deliberate asymmetry: a
description edit in SKILL.md frontmatter *does* bump the sha, because
frontmatter ships to Claude and genuinely changes runtime behavior — hashed
iff delivered. `promote` and `share` cache and restore the data-repo sidecar
around their directory replaces so promoting content never deletes upstream
metadata.

`sourceCommit` is sidecar-blind too: copy-item pins are computed by
`lastTouchingContentCommit` (`git log -1` with a
`:(exclude)<item>/.capshelf.yml` pathspec, falling back to the unfiltered
commit for sidecar-only histories), so a metadata-only data-repo commit
leaves `update` a true no-op — the lock file is not rewritten. Fragment
items are immune by construction: their `sourceCommit` is computed from
canonical source paths only. `ls`/`show`/`search` read metadata from the
data repo **working tree** — a catalog view of the shelf as it is now, not a
pinned view per `sourceCommit`.

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
- **Skip already-installed members.** Re-running a bundle add never
  re-applies or pin-bumps installed members (standalone `add` keeps its
  implicit re-apply; the skip is the bundle executor's). Re-run is both the
  recovery path and the upgrade path after the team grows the bundle.
- **Flat composition.** Bundles cannot include bundles; `show
  bundles/<name>` always displays the complete literal member list with
  per-member availability and install state.
- **Discovery.** `ls` appends a `bundles/` section, `search` ranks bundles
  alongside items (member refs score as content), and all bundle JSON
  surfaces are append-only sibling keys.

## Codex parity

Same model, different output paths. Codex items live under `codex/` in a data repo. A single project manifest can mix Claude and Codex items. One lockfile, one `apply`, both toolchains stay in sync.

## What the human does (and doesn't)

Humans approve data-repo writes and glance at `status` when starting a project.
Agents handle the current CLI workflow — discover (`search`, `ls --tag`,
`show bundles/<name>`), inspect, edit, share, move, promote, and reconcile —
via the CLI surface in `cli.md`. Validation is a roadmap workflow.
