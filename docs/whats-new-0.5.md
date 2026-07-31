# What's new in capshelf 0.5

Capshelf 0.5 adds project-local Pi extensions, shows the skills already
installed in your user-level Claude and Codex directories, and makes the CLI
safer to use from scripts and day-to-day project work. It also includes a set
of path, lockfile, and write-safety fixes found during a focused code review.

This page covers 0.5.0. Existing projects and data repos need no migration.

## Share project-local Pi extensions

Pi extensions are now a managed copy-item kind. Store an extension in the data
repo with an `index.ts` entry point:

```text
pi/extensions/path-guard/
  index.ts
  package.json       # optional
  src/…
  .capshelf.yml      # optional catalog metadata
```

Then inspect and add it like any other data item:

```bash
capshelf show pi-extensions/path-guard
capshelf add pi-extensions/path-guard
# Run /reload in Pi, or restart Pi.
```

Capshelf copies the pinned content to `.pi/extensions/path-guard/` and tracks
it in the project manifest and lockfile. Pi extensions also work in bundles
and through the normal `status`, `update`, `promote`, `revert`, `rm`, and
`get-path` flows.

Extensions run TypeScript with your permissions after Pi trusts the project.
Capshelf warns before materializing or promoting one, but it does not sandbox
the code, install dependencies, edit `.pi/settings.json`, or reload Pi. A
`package.json` with dependencies produces a second advisory warning so you can
install them yourself.

Pi extensions are project-scope only. Clone-local operations such as
`capshelf add pi-extensions/path-guard --local` are rejected, and
`keep-local` remains limited to skills.

## See skills installed outside capshelf

`ls` and `status` now include a read-only inventory of skills installed at
user scope for Claude and Codex:

```bash
capshelf ls --user
capshelf status --user
```

Capshelf scans these locations:

- `~/.claude/skills/<name>/SKILL.md`
- `~/.agents/skills/<name>/SKILL.md`
- `$CODEX_HOME/skills/<name>/SKILL.md`, or `~/.codex/skills/<name>/SKILL.md`

The `--user` form works without a capshelf project or data repo. Inside a
project, the report also identifies user-level skills that have the same name
as a project or clone-local capshelf skill. This inventory is informational:
capshelf never adopts, rewrites, or removes those user-level directories.

## Run commands from where you are

Project commands now walk up to the nearest `.capshelf/capshelf.json`, so they
work from any subdirectory of a capshelf project:

```bash
cd ~/code/my-app/packages/api
capshelf status
```

`init` still acts on the current directory. It does not walk upward, because
its job is to create a new project boundary.

The read-only `ls`, `search`, and `show` commands can also run outside a
project when you provide a data repo. This lets you inspect a shelf before
connecting a project to it:

```bash
capshelf --data ~/code/agent-config search security
capshelf --data ~/code/agent-config show security-review
```

## A clearer data-repo command group

Data-repo commands now live under one top-level group:

```bash
capshelf data bind ~/code/agent-config
capshelf data path
capshelf data sync
capshelf data upstream https://github.com/acme/agent-config
```

The previous `set-data`, `data-path`, `sync-data`, and `set-upstream` commands
remain as hidden aliases, so existing scripts continue to work.

## Safer config fragments

Settings and MCP JSON files can now contain comments and trailing commas.
Capshelf reads them as JSONC instead of rejecting syntax accepted by Claude.
When a managed rewrite serializes the file as plain JSON, capshelf warns that
comments will be removed.

Capshelf also refuses conflicts between managed fragments. Two fragments can
still contribute different object keys, mergeable arrays, or the same value;
they cannot assign different scalar values or incompatible shapes to the same
path. The error names both owning fragments instead of silently choosing one
based on manifest order.

## More predictable output and failure handling

Commands passed `--json` now emit structured errors on stderr:

```json
{"error":{"message":"no data repo configured for this project","exitCode":6}}
```

Common precondition failures now use documented exit codes instead of falling
through to exit 1. Exit 6 is active for a missing data-repo binding, while
conflicting scopes, dirty Git state, invalid flag combinations, and similar
refusals use exit 3.

Other command-line fixes include:

- `status --diff` now uses the locked content as the old side and the current
  content as the new side, matching `git diff`.
- `keep-local` refuses an unchanged skill instead of hiding future update
  signals for it.
- Fragment update failures report the correct target and item kind.
- Data-repo item names, manifest entries, lock keys, and Git revisions receive
  stricter validation before they reach filesystem or Git operations.
- Non-ASCII item names work through add, apply, and data-repo rebinding.

## Safer writes and paths

Capshelf now writes manifests, lockfiles, local config, merged agent config,
and materialized item content through a temporary sibling followed by rename.
A stopped process or full disk should no longer leave a truncated persistent
file in place.

Install destinations are checked to remain inside the project root. Capshelf
also refuses a `.claude/skills/<name>` compatibility symlink that points
somewhere other than the canonical managed skill directory, preventing a
malformed alias from redirecting a replace operation outside capshelf's owned
paths.

Lockfile Git object names and item paths are validated on load. Content hashing
for add, apply, and data-repo rebinding now shares one implementation, including
the correct treatment of `.capshelf.yml` sidecars.

## Upgrading

```bash
capshelf self-update        # Homebrew installs
# or re-run the install script / git pull && make install for source installs
```

There are no manifest, lockfile, or data-repo migrations. The older top-level
data-repo commands remain compatible with 0.5.
