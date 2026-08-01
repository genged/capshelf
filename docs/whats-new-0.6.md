# What's new in capshelf 0.6

Capshelf 0.6.0 can manage one subagent definition across Claude and Codex,
turn canonical skills into independent runtime plugin catalogs, record the
runtime access each item expects, and merge a local edit with a newer upstream
version during `promote`. Pi extensions can now be clone-local too.

This release changes the lockfile schema from version 2 to version 3. Existing
version 2 locks load without a manual migration, but capshelf 0.5 cannot read a
lock after 0.6 writes it. Upgrade every machine and CI runner that works on a
project before committing a version 3 lock.

## Manage one subagent across Claude and Codex

A data repo can now store a Claude definition, a Codex definition, or both
under one item:

```text
subagents/reviewer/
  claude.md    -> .claude/agents/reviewer.md
  codex.toml   -> .codex/agents/reviewer.toml
```

Inspect each target, add the logical item once, and ask for either runtime
output when you need its path:

```bash
capshelf show subagents/reviewer --target claude
capshelf show subagents/reviewer --target codex
capshelf add subagents/reviewer
capshelf get-path subagents/reviewer --target claude --output
capshelf get-path subagents/reviewer --target codex --output
```

Both target files share one manifest selection and one lock entry. The normal
`status`, `apply`, `update`, `promote`, `revert`, and `rm` flows operate on the
pair together. If an update removes one canonical target, Capshelf removes the
formerly managed runtime file for that target.

Existing unmanaged runtime definitions can be adopted together:

```bash
capshelf share subagents/reviewer --to project -m "share reviewer subagent"
```

Subagents are project-scope only. Capshelf does not translate formats, install
only one target, put agents in user-global directories, support `keep-local`,
or merge stale subagent promotes with `--merge`. Claude definitions require
`name` and `description` frontmatter plus a prompt body; Codex definitions
require `name`, `description`, and `developer_instructions` in TOML.

## Build Claude, Cowork, and Codex plugin catalogs

The new `marketplace` command group composes canonical skills into independent
Claude/Cowork and Codex plugins. It operates directly on a Git data repo, so it
can run outside a Capshelf project:

```bash
capshelf --data ~/code/agent-config marketplace init \
  --target claude --name company-workflows --owner Engineering
capshelf --data ~/code/agent-config marketplace init \
  --target codex --name company-codex --owner Engineering

capshelf --data ~/code/agent-config marketplace plugin create engineering \
  --target claude \
  --skill skills/security-review \
  --skill skills/test-planning
capshelf --data ~/code/agent-config marketplace plugin create engineering \
  --target codex \
  --skill skills/security-review

capshelf --data ~/code/agent-config marketplace validate
```

Claude definitions live in the official
`.claude-plugin/marketplace.json`. Codex definitions live under
`codex/plugin-definitions/` and project to a native catalog at
`.agents/plugins/marketplace.json` plus self-contained plugin roots under
`codex/generated/`. Codex skill changes can be projected and checked with:

```bash
capshelf --data ~/code/agent-config marketplace sync --target codex
capshelf --data ~/code/agent-config marketplace validate --target codex
codex plugin marketplace add ~/code/agent-config
```

Marketplace mutations require a clean data repo, validate the complete target,
stage only Capshelf-owned paths, and create one local commit. They never push
or install anything into Claude, Cowork, or Codex. `marketplace sync` repairs
the Codex projection without staging or committing it.

Standalone packages are available for Cowork upload or detached Codex
distribution. The output must be outside the data repo:

```bash
mkdir -p /tmp/capshelf-artifacts
capshelf --data ~/code/agent-config marketplace plugin pack engineering \
  --target claude \
  --output /tmp/capshelf-artifacts/engineering.plugin
capshelf --data ~/code/agent-config marketplace plugin pack engineering \
  --target codex \
  --output /tmp/capshelf-artifacts/engineering-codex
```

Packages and generated Codex roots contain regular, Git-visible selected-skill
files. Symlinks, private dotenv files, unsafe paths, dangling skill selections,
and replacement of different existing output are refused. Package builds are
deterministic; rebuilding identical output reports `already-built`.

## Declare runtime needs without changing item content

Every item kind can now declare expected network hosts, environment variables,
and commands in its `.capshelf.yml` sidecar:

```yaml
needs:
  network: [api.example.com]
  env: [EXAMPLE_TOKEN]
  bin: [example-cli]
```

`add`, `share`, `promote`, bundle expansion, and `update` pin the declaration
separately from the item's content. A later sidecar-only change can therefore
produce a requirements update while the content state remains `ok`:

```bash
capshelf show skills/network-helper
capshelf status skills/network-helper
capshelf update skills/network-helper --dry-run
capshelf update skills/network-helper
```

A needs-only update changes the lock without rewriting unchanged installed
files. `show --json` reports current and locked needs; `status --json` reports
`needsState` and `lockedNeeds`. Bundle previews return the union of their
members' current declarations.

Capshelf treats these fields as runtime-neutral declarations. It displays and
pins them, but does not inspect external runtime policy, probe environment
variables or commands, enforce access, or satisfy requirements.

## Merge a stale promote

Stale-promote protection used to leave two choices: take upstream and redo the
local edit, or deliberately overwrite upstream with `--stale-ok`. Supported
copy items now have a third choice:

```bash
capshelf status skills/security-review --diff
capshelf promote skills/security-review --merge \
  -m "merge local security checks"
```

Capshelf performs a standard three-way merge using the locked item as the
base, the installed item as local, and the current data-repo item as upstream.
A clean result is committed once and reconciled back into the calling project.
A conflict lists the item-relative paths and leaves the data repo, project,
manifest, and lock unchanged.

`--merge` works for skills in project or clone-local scope and for
project-scope Pi extensions. It does not support local Pi extensions,
subagents, fragments, or system items. `--merge` and `--stale-ok` are mutually
exclusive, and uncommitted edits in the data-repo item path still block both.

## Keep Pi extensions clone-local

Pi extensions now support the same project/clone-local lifecycle as skills:

```bash
capshelf add pi-extensions/path-guard --local
capshelf status pi-extensions/path-guard --local
capshelf keep-local pi-extensions/path-guard --local \
  --reason "machine-specific paths"
capshelf move pi-extensions/path-guard --to project
```

Both scopes materialize to `.pi/extensions/<name>/`; the scope controls
Capshelf intent and lock ownership, not Pi runtime scope. Local Pi extension
paths are excluded from project Git in Git projects. The existing trust rules
still apply: review the source, install dependencies yourself, then run
`/reload` in Pi or restart it.

Bundles containing only skills and Pi extensions can now be installed with
`--local`. Fragments and subagents remain project-only and make a local bundle
preflight fail before any writes.

## Smaller improvements

- `rm` now identifies when an item is installed in the other scope and prints
  the correct command. Tree deletion retries transient permission or non-empty
  failures and gives recovery guidance when another process keeps the path
  busy.
- Ordinary `status` no longer loads every locked file blob for copy items.
  Locked bytes are loaded only when `--diff` needs them.
- The exported CLI entry point is reentrant. Repeated in-process calls no
  longer retain parsed options, and help or usage failures return an exit code
  instead of terminating the host process.
- Unit tests and smoke suites run with four workers by default. `make test-all`
  runs both, while `make check` still adds typecheck and lint.
- The README quickstart now distinguishes installing an existing data-repo
  skill from adopting a skill already present in a project, states the working
  directory for examples, and explains what `promote` changes.

## Breaking changes

- Lockfiles are now version 3. Data entries add `needs` and
  `needsSourceCommit`. Capshelf 0.6 reads version 2 locks in memory and leaves
  them untouched during read-only commands, but the next command that saves a
  lock writes version 3. Capshelf 0.5 cannot read that file.
- No CLI commands were removed. The compatibility break is one-way lockfile
  writing: once a project commits a version 3 lock, every contributor and CI
  runner for that project must use Capshelf 0.6 or newer.

## Upgrading

Upgrade Capshelf before running a command that changes project state:

```bash
capshelf self-update        # Homebrew installs
# or re-run the install script / git pull && make install for source installs
capshelf status
```

There is no manifest or data-repo migration. Version 2 locks continue to work
until a normal write upgrades them. For an existing item whose locked needs
show as unknown, review the pending item update first, then capture the current
declaration and commit the resulting project lock change:

```bash
capshelf update skills/network-helper --dry-run
capshelf update skills/network-helper
git add .capshelf/capshelf.lock.json
git commit -m "upgrade capshelf lock to v3"
```

Coordinate that commit with the rest of the team so older Capshelf binaries do
not encounter the version 3 lock.
