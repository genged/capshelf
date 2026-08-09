---
name: capshelf
description: Use the capshelf CLI to manage shared skills, Pi extensions, subagents, settings, and MCP configs across multiple projects from a user-owned data repo.
---

# capshelf

This project uses **capshelf** to track shared coding-agent config (skills, project-local Pi extensions, Claude/Codex subagents, settings fragments, MCP configs) pulled from a **data repo**. When the user asks to add, remove, discover, edit, or update shared config, use the `capshelf` CLI. **Do not hand-edit** `.capshelf/capshelf.json` or `.capshelf/capshelf.lock.json` — they are tool-managed.

Run project commands from anywhere inside a capshelf project — the directory containing `.capshelf/capshelf.json`, or any subdirectory of it (capshelf walks upward to find the root, like git). `init` acts on the current directory, not a discovered parent.
Use `init` only for a new project or a fresh clone without
`.capshelf/local.json`; it refuses a project already initialized on this
machine. Use `data bind`, `data upstream`, and `update` for later lifecycle
changes.

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

`capshelf show <item>` prints the full description, `requires`, `conflicts-with`, and whether each relation is already installed. Use it before committing to an `add`. For `pi-extensions/*`, read **all extension source** shown before adding: Pi executes it as arbitrary code with full user permissions after project trust.

### 4. Install

`capshelf add <item>`. Repeating add for an installed item is a stable no-op; use the printed `status --diff`, `update`, and `apply` guidance instead of trying to make add reapply it. If the output lists missing required items, install them with the exact `capshelf add <ref>` commands it prints. If `add` refuses with exit 3 because of a `conflicts-with` declaration, that is a curated incompatibility — surface the decision to the user (remove the conflicting item, or fix a stale declaration in the data repo); never work around it. A bundle preflight refusal (exit 3) is the same kind of decision: nothing was installed and the per-member report says why — surface it, don't install members one by one to route around it.

### 5. Verify

`capshelf status --strict` — exit 0 means the project has converged on its locks.

### 6. Edit / promote loop

When the user asks you to improve a shared (data) item:

1. `capshelf get-path <item>` for the absolute editable path (fragments return canonical data-repo source files; `--output` returns generated outputs for inspection only).
2. Edit with your Edit/Write tools.
3. `capshelf status <item>` — should report `drifted_local` (or `source_dirty` for fragments).
4. Decide with the user:
   - `capshelf promote <item> -m "why"` — push to the data repo. Other projects see `update available` next time they check; nothing auto-changes.
   - `capshelf keep-local <item> --reason "why"` — intentional project-specific divergence for a copy item (skill or Pi extension).
   - `capshelf revert <item>` — discard the edit, restore from the recorded `sourceCommit`; first show `capshelf status <item> --diff` and get permission before using `--yes` in a non-interactive run.

For Pi extensions, inspect the changed source before promoting and tell the user to run `/reload` or restart Pi after materialization. Never imply that capshelf reviewed, trusted, sandboxed, or dependency-installed the extension.

If `promote` fails with "changed in the data repo since this project last updated" (exit 3), a teammate's newer version is upstream. Show the user the upstream diff (`capshelf status <item> --diff` plus the scoped `git log` from the error message). For a skill in either scope or a project-scope Pi extension, offer `capshelf promote <item> --merge -m "why"` to three-way merge the locked base, installed edits, and current upstream. A merge conflict lists paths and writes nothing. Other choices are preserving the edit and running `capshelf update <item>` before redoing it, or an intentional overwrite. **Do not retry with `--stale-ok` on your own**; `--merge` and `--stale-ok` are mutually exclusive. `update` preflights local drift and asks before replacing installed content; non-interactive and JSON calls refuse unless `--yes` is passed. Review `capshelf status <item> --diff` and get the user's permission before using `update --yes`. For a local-scope item, preserve `--local` on recovery and merge commands. A merged or ordinary promote that reports `already-upstream` means the lock was re-pinned without a data-repo commit.

To change **metadata** (tags, description, `requires`/`conflicts-with`, or declared `needs`), edit the item's canonical data-repo sidecar (`skills/<name>/.capshelf.yml`, `pi/extensions/<name>/.capshelf.yml`, or the fragment path shown by `capshelf show`) and commit it in the data repo. Metadata is never hashed into item content. Tags, descriptions, and relations are live catalog data and need no project update; needs are lock-pinned, so consuming projects run `capshelf update <item>` to select a changed declaration without reinstalling unchanged content. **Commit the sidecar before returning to project work**: an uncommitted sidecar edit blocks `capshelf update` entirely (dirty data repo) and blocks `add` of that item.

For a skill's **description**, prefer SKILL.md frontmatter — it doubles as the catalog fallback. Know the trade-off when choosing where to edit: a frontmatter edit is content drift (shipped to Claude, hashed — consuming projects see `update available`), while a sidecar edit is drift-free. Add a sidecar `description` only when the catalog blurb should differ from the frontmatter's invocation-trigger phrasing, or when tuning copy must not ship a content change; sidecar wins when both exist. Fragment items (settings/mcp/codex-config) have no frontmatter — the sidecar is their only description source.

For system items (e.g. this `capshelf` skill), the edit loop doesn't apply — to change them, edit the CLI source under `src/bundled/` and rebuild.

## How it works

- **Data repo** (e.g. `~/code/work-skills/`) holds canonical versions of every shared item under `skills/`, `pi/extensions/`, `subagents/`, `settings/`, `mcp/`, and `codex/config/`. It must be a git repo. Resolution order: `--data <path>` flag > gitignored `.capshelf/local.json` > `$CAPSHELF_HOME`. There is no implicit default.
- **This project** pins the exact content hash + source commit of each item in `.capshelf/capshelf.lock.json` (clone-local pins in gitignored `.capshelf/local.lock.json`). Data-repo updates do NOT propagate until this project runs `capshelf update`.
- **Installed copies** live under `.agents/skills/<name>/` by default with `.claude/skills/<name>` symlinks (Claude-only projects install directly under `.claude/skills/<name>/`). Pi extensions live under `.pi/extensions/<name>/`. Claude custom commands are modeled as skills.
- **Subagents** are project-scoped logical items. `subagents/<name>/claude.md` installs to `.claude/agents/<name>.md`; `subagents/<name>/codex.toml` installs to `.codex/agents/<name>.toml`. Either target or both may exist under one lock.
- **Item metadata** (optional `<item>/.capshelf.yml` in the data repo: `description`, `tags`, `requires`, `conflicts-with`, `needs`) feeds discovery and checks. It is never copied into projects. Needs are pinned separately from content so requirements freshness never changes content drift.

## Two kinds of items

- **system** (lock prefix `system/`): bundled into the CLI binary, installed by `init`, read-only from a project's perspective.
- **data** (lock prefix `data/`): live in your data repo. Added via `add`, removed via `rm`, adopted via `share`, pushed back via `promote`.

Mutating commands only touch files tracked in the lockfiles: `add` refuses to overwrite an existing untracked target, and `rm` deletes only locked data items. Copy-directory items can use committed project scope or clone-local scope; subagents are project-only. `share skills/<name>` defaults to local scope; Pi extensions default to project scope, so pass `--to local` when adopting one as clone-local intent.

## Command reference

Always check the current surface with `capshelf --help` and `capshelf <verb> --help`. Most item arguments accept a bare unique name (`hello`) or a kind-qualified ref (`skills/hello`).

| verb | purpose |
|---|---|
| `init` | initialize a new project or onboard a fresh clone without `.capshelf/local.json`; never use it to reinstall or rebind an initialized machine |
| `data bind` / `data upstream` / `data path` | inspect or change the explicit data-repo binding (old `set-data`/`set-upstream`/`data-path` still work as aliases) |
| `ls` / `show` / `search` / `status` | inspect and discover (all support `--json`; `ls` and `status` include user-level runtime skills by default, `--user` narrows to them only) |
| `add` / `rm` / `apply` / `update` / `revert` | converge the project on its locks |
| `share` / `move` / `promote` / `keep-local` | flow content and intent between project and data repo |
| `data sync [--json]` | explicitly fetch the bound data repo's origin and fast-forward when safe; the **only** capshelf command that touches the network besides the `init` bootstrap clone and `self-update`. Run it when the user asks to pick up teammates' changes, then `capshelf status` to see `update_available` |
| `get-path` | print the editable path for an item; use `--target claude|codex` for multi-target subagents |
| `self-update` | update the Homebrew-installed binary (not project pins) |
| `marketplace ...` | author, validate, sync, and package data-repo Claude/Cowork or Codex plugin catalogs; never installs runtime plugins |

## Plugin marketplaces

Use `capshelf marketplace` when the user wants to group canonical data-repo
skills into a Claude/Cowork or Codex plugin. Claude and Codex are independent
targets: always pass `--target` for mutations and do not mirror membership
unless the user asks.

Marketplace/plugin identities are kebab-case and `plugin create` requires at
least one canonical skill. Codex installation policy values are
`NOT_AVAILABLE`, `AVAILABLE`, and `INSTALLED_BY_DEFAULT`; authentication
policy values are `ON_INSTALL` and `ON_USE`. Target-inapplicable options are
errors. Validation JSON contains target-labeled configuration, projection,
source-path and file/byte accounting, known Cowork limits, and structured issue
objects. An explicit `--cowork-url` is a user assertion and produces a warning;
strict validation therefore refuses it unless the support can be classified
from the repository origin.

Run `marketplace validate` before publication. After direct Codex definition
or selected-skill edits, run `marketplace sync --target codex --dry-run
--json`, review source and generated diffs together, then sync and commit them
together. Sync never stages or commits. If it refuses because an affected
projection path is dirty, surface every path and get permission before using
`--yes`. Marketplace mutations do make one local data-repo commit but never push.

For local handoff, `marketplace plugin pack <name> --target claude --output
<outside-path>.plugin` builds a Cowork upload, while the data repo itself is
the primary local Codex marketplace. Stop after printing the runtime handoff:
do not register a marketplace, upload/install/refresh a plugin, restart an
app, or edit a runtime cache unless the user separately asks for that runtime
action.

Canonical skills have no Capshelf data-repo rename/delete command. If the user
renames one directly, update every Claude and Codex membership in the same Git
change, sync Codex, and validate both targets. Remove every membership before
deleting a skill; dangling refs intentionally block validation, sync,
packaging, and further marketplace mutations.

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

## Pi extensions

`pi-extensions/<name>` maps `pi/extensions/<name>/index.ts` in the data repo to `.pi/extensions/<name>/index.ts` in the project. Extensions support the same project/clone-local lifecycle as skills, including `add --local`, `share --to local`, `move --to local`, and `keep-local`. Both Capshelf scopes materialize to Pi's project-local extension path; Capshelf does not manage user-global extensions.

Pi loads project extensions only after project trust, but then they execute arbitrary TypeScript with full system permissions. Always inspect source before `add`, before `promote`, and before asking the user to `/reload` or restart Pi. Capshelf does not sandbox code, validate TypeScript, edit `.pi/settings.json`, manage Pi packages, invoke package managers, or install `package.json.dependencies`; dependency declarations produce an advisory warning only. Do not run install commands on the user's behalf as part of capshelf reconciliation.

## Subagents

`capshelf add subagents/<name>` installs every available Claude/Codex target
under one lock. Use `show --target` or `get-path --target`; add never accepts a
partial target. `share subagents/<name> --to project` adopts every matching
unmanaged project runtime file, while `--from` requires `--target`.

Subagents are project-scope only. Do not use `--local`, `keep-local`, or
`promote --merge`; the supported stale overwrite escape hatch is
`promote --stale-ok` with explicit user direction. Review subagents like
privileged runtime policy because they can combine instructions with tools,
models, permissions, MCP servers, and sandbox controls.

## Config fragments

Shared fragments merge into project config outputs: `settings/<name>/settings.json` → `.claude/settings.json`; `mcp/<name>/claude.json` → `.mcp.json`; `mcp/<name>/codex.toml` and `codex/config/<name>/config.toml` → `.codex/config.toml`. Outputs preserve unmanaged project-local values; capshelf refuses unmanaged scalar/shape collisions, and also refuses two fragments that set the same key to conflicting scalar values (naming both) rather than silently letting manifest order decide. JSON outputs are read as JSONC (comments tolerated) but rewritten as plain JSON, and TOML is reserialized. Capshelf detects comment loss during preflight; review the named output and get permission before using `--yes`.

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
- **User-level runtime skills**: `capshelf ls` and `capshelf status` include these by default; use `--user` to show only them. These scan `~/.claude/skills`, `~/.agents/skills`, and `$CODEX_HOME/skills`/`~/.codex/skills`, split Claude and Codex human output by runtime, report shadowing when run from a project root, and never adopt or mutate those skills.
- Files or values in agent surfaces that are not locked contributions are project-local; capshelf preserves or ignores them.

## Safety rules

- **Never run `capshelf promote`** while the user has open PRs on other projects using that item, unless those projects are OK picking up the change on their next `update`.
- **Treat `add` conflict refusals (exit 3) as decisions for the user**, not obstacles. There is no force flag by design.
- **Do not work around an already-initialized `init` refusal.** Use the named
  `data` or `update` command; install-mode changes need a dedicated migration.
- **Never pass `promote --stale-ok` without explicit user direction** — it intentionally overwrites a teammate's newer upstream version.
- **Never pass `--yes` merely to route around a destructive-change refusal.** Show every affected path, use `capshelf status <item> --diff` for managed item drift (or marketplace sync dry-run for projections), explain what will be lost, and get the user's permission first. `--yes` does not bypass hard safety refusals.
- **The lock is the source of truth** for what capshelf owns.
- **Review Pi extension source before adding or promoting it.** The runtime warning is a trust boundary, not proof of safety; capshelf never installs extension dependencies or reloads Pi.
- **Treat declared needs as metadata.** Capshelf records expected network,
  environment, and command requirements but does not satisfy or enforce them.
- **Use `capshelf self-update` only for Homebrew installs**; source installs update with `git pull && make install`. Set `CAPSHELF_NO_SELF_UPDATE=1` to suppress startup prompts.

## Troubleshooting

- `no data repo configured` — clone the declared `dataRepoUpstream` if one exists, then `capshelf set-data <path>`, or pass `--data <path>`, or set `$CAPSHELF_HOME`.
- `capshelf is already initialized for this machine` — use `capshelf data bind
  <path>`, `capshelf data upstream <url>`, or `capshelf update`; do not delete
  `.capshelf/local.json` to route around the state boundary. The one exception
  is a genuinely half-initialized project: `init` refuses while `apply` reports
  `(no items tracked)`. `local.json` is init's last write, so a current
  capshelf never leaves that state; if an older one did, delete
  `.capshelf/local.json` and re-run `capshelf init`. The re-run adopts a
  leftover system item only when its content matches the running binary
  exactly; otherwise it refuses and names the path, and deleting that directory
  is safe because `init` reinstalls system items from the binary.
- `could not determine a portable data repo upstream` — configure the data repo's `origin` before `capshelf init`, or pass `--no-upstream` only for an intentionally non-portable local project.
- `data repo at <path> is bound to the wrong upstream` — `capshelf set-data <correct-clone>` or intentionally change committed state with `capshelf set-upstream <url>`.
- `data repo has uncommitted metadata changes: <item>/.capshelf.yml` — commit the sidecar in the data repo; no item content is at risk.
- `missing_source_commit` in `status` — the locked `sourceCommit` is unreachable in the data repo (unpushed in another clone, or squash-orphaned after a merged proposal). Fix with `capshelf sync-data && capshelf update <item>`; if the commit only exists in another clone, push or fetch that clone first.
- `git is required but was not found on PATH` — install Git or fix `PATH`.
- `not a git repository: <path>` — data repos must be git repos (`sourceCommit` provenance); `git init` it first.
- `⚠ <item>: invalid .capshelf.yml … — metadata ignored` — the item still works; fix the sidecar in the data repo when convenient.
- `capshelf: command not found` — the CLI isn't on `PATH` (common when a teammate cloned this project, which has the capshelf skill committed, but never installed the binary). Recover with `brew install genged/tap/capshelf`, or without Homebrew run `curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh` (downloads the latest release, verifies its checksum, installs to `~/.local/bin`; ensure that dir is on `PATH`). Building from source (`make install`) is a fallback; point the user at the repo README for the current options.
