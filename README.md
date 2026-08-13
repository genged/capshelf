<p align="center">
  <img src="docs/logo.png" alt="Capshelf logo" width="200" />
</p>
<h1 align="center">Capshelf</h1>
<h3 align="center">Shared Agent Configuration between Repositories</h3>
<p align="center">
<a href="https://github.com/genged/capshelf/actions/workflows/release.yml">
  <img src="https://github.com/genged/capshelf/actions/workflows/release.yml/badge.svg" alt="Release status"/>
</a>
<a href="https://github.com/genged/capshelf/releases/latest">
<img src="https://img.shields.io/github/v/release/genged/capshelf?sort=semver" alt="Latest release" />
</a>
<img src="https://img.shields.io/badge/License-MIT-yellow.svg" />
</p>

A Git-backed CLI for sharing coding-agent configuration — skills, Pi
extensions, subagents, settings, and MCP fragments — across projects, with
per-project lockfiles so a change in one repo never disturbs work in another.

As you accumulate projects, you accumulate copies of the same skills, the same
settings overlays, the same MCP servers. Keeping them in sync by hand, or by
whole-directory symlinks, is fragile.

```bash
# Run from the root of the project that will use the shared skill.
cd ~/code/my-app
capshelf init --data https://github.com/acme/agent-config
capshelf add security-review
$EDITOR "$(capshelf get-path security-review)/SKILL.md"
capshelf status security-review --diff
capshelf promote security-review -m "tighten SQLi check"
```

`promote` commits the edited skill to the data repo and updates the current
project's pin. Other projects keep their existing version until they run
`capshelf update`.

## Quickstart

### 1. Install Capshelf

```bash
brew install genged/tap/capshelf
```

Capshelf also needs `git` on your `PATH`.

Without Homebrew, use the install script. It downloads the latest GitHub
release for your platform, verifies its SHA-256 checksum, and installs to
`~/.local/bin/capshelf`:

```bash
curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh
```

To build from this repo instead:

```bash
bun install
make install     # builds dist/capshelf and copies it to ~/.local/bin/capshelf
```

Make sure `~/.local/bin` is on your `PATH` when using the source install.

Homebrew installs can check or apply binary updates with:

```bash
capshelf self-update --check
capshelf self-update
```

Source installs update manually with `git pull && make install`.

### 2. Choose a data repo

A data repo is a normal Git repo that stores shared agent config. If your team
already has one with skills under `skills/<name>/`, use it directly and skip
to the next step.

If your skills currently live inside project repositories, start with an empty
data repo. Capshelf can adopt the existing skills after you connect a project.

```bash
mkdir -p ~/code/agent-config
cd ~/code/agent-config
git init
git remote add origin https://github.com/acme/agent-config
git commit --allow-empty -m "initialize shared agent config"
```

### 3. Connect a project

To install a skill that is already in the data repo:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
capshelf ls
capshelf add security-review
capshelf status
```

If the skill already lives in this project under
`.agents/skills/security-review/` or `.claude/skills/security-review/`, adopt it
instead:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
capshelf share skills/security-review --to project \
  -m "share existing security-review skill"
capshelf status
```

Repeat the `share` command from each repository that contains skills you want
to centralize.

`init` records the data repo's `origin` as `dataRepoUpstream` so future clones
can discover the same source. For a machine-local sandbox, use
`capshelf init --data ~/code/agent-config --no-upstream` instead.

By default, skills are installed under `.agents/skills/<name>/` and exposed to
Claude through `.claude/skills/<name>` symlinks. Use `capshelf init
--claude-only --data <repo>` if a project should write real skill directories
directly under `.claude/skills/`.

## Examples

Add a shared skill:

```bash
capshelf ls
capshelf show security-review --no-content
capshelf add security-review
```

Update a project when the data repo changes:

```bash
capshelf status
capshelf update --dry-run
capshelf update
```

Edit a skill locally, then choose what to do with the drift:

```bash
$EDITOR "$(capshelf get-path security-review)/SKILL.md"
capshelf status security-review --diff

capshelf promote security-review -m "tighten security review checklist"
# or:
capshelf keep-local security-review --reason "project-specific review rules"
# or:
capshelf revert security-review
```

Adopt a project-local skill into the shared data repo:

```bash
mkdir -p .agents/skills/write-migration
$EDITOR .agents/skills/write-migration/SKILL.md
capshelf share skills/write-migration --to project -m "add write-migration skill"
```

Share fragment values that already live in this project's generated outputs —
no separate source file needed; the output file is unchanged and the picked
values simply become managed:

```bash
capshelf share mcp/github                                    # adopt the unmanaged `github` server from .mcp.json / .codex/config.toml
capshelf share settings/permissions --pick permissions.allow # extract a settings value by path
```

Add a project-local Pi extension from `pi/extensions/<name>/index.ts` in the
data repo (review it first; extensions execute arbitrary code after Pi project
trust):

```bash
capshelf show pi-extensions/path-guard
capshelf add pi-extensions/path-guard
# or keep the selection clone-local:
capshelf add pi-extensions/path-guard --local
# then run /reload in Pi or restart Pi
```

Add shared config fragments:

```bash
capshelf add settings/security-base
capshelf add mcp/github
capshelf add codex-config/defaults
capshelf get-path mcp/github --target codex
capshelf get-path mcp/github --target codex --output
```

Add one logical subagent for every runtime definition it provides:

```bash
capshelf add subagents/reviewer
capshelf get-path subagents/reviewer --target claude --output
capshelf get-path subagents/reviewer --target codex
```

Set up a whole service from a curated bundle (`bundles/<name>.yml` in the
data repo) — members install as independent items, all-or-nothing:

```bash
capshelf search "go backend"
capshelf show bundles/go-backend     # preview members + install state
capshelf add bundles/go-backend
```

Curate the same canonical skills into independent Claude/Cowork and Codex
plugins without installing either runtime:

```bash
capshelf --data ~/code/agent-config marketplace init \
  --target codex --name company-workflows --owner Engineering
capshelf --data ~/code/agent-config marketplace plugin create engineering \
  --target codex --skill skills/security-review
capshelf --data ~/code/agent-config marketplace validate --target codex
```

The data repo is then a native local Codex marketplace. Claude entries use
the official `.claude-plugin/marketplace.json`; `plugin pack --target claude`
builds a standalone `.plugin` file for Cowork upload. Capshelf creates and
commits catalog state, but never registers, installs, refreshes, or removes a
runtime plugin. Identities are kebab-case, plugin creation requires a skill,
and validation reports target configuration, projection drift, structured
issues, known Cowork limits, and package/file-byte accounting.

Bootstrap a new project straight from a shared data repo URL (capshelf clones
it once under `~/.local/share/capshelf/data/...`, or to `--data-dir <path>`,
and binds the local clone):

```bash
cd ~/code/my-app
capshelf init --data https://github.com/acme/agent-config
capshelf add security-review
```

Connect a freshly cloned project to its data repo:

```bash
cd ~/code/my-app
capshelf init
capshelf apply
```

That works when the project committed `.capshelf/capshelf.json` with a
`dataRepoUpstream`. If you already cloned the data repo somewhere custom, use
`capshelf set-data <path-to-data-repo>` instead of `capshelf init`.

## What Capshelf Manages

| Kind | Data repo path                       | Project output |
|---|--------------------------------------|---|
| `skills` | `skills/<name>/SKILL.md` plus assets | `.agents/skills/<name>/` and `.claude/skills/<name>` symlink |
| `pi-extensions` | `pi/extensions/<name>/index.ts` plus local modules | `.pi/extensions/<name>/` |
| `subagents` | `subagents/<name>/claude.md`, `subagents/<name>/codex.toml` | `.claude/agents/<name>.md` and/or `.codex/agents/<name>.toml` |
| `settings` | `settings/<name>/settings.json`      | merged into `.claude/settings.json` |
| `mcp` | `mcp/<name>/claude.json`, `mcp/<name>/codex.toml` | merged into `.mcp.json` and/or `.codex/config.toml` |
| `codex-config` | `codex/config/<name>/config.toml` | merged into `.codex/config.toml` |

Pi extensions can use committed project scope or clone-local Capshelf scope;
both materialize to Pi's project-local `.pi/extensions/<name>/` path and execute
arbitrary code after Pi project trust. Capshelf reports that warning, but does
not sandbox extensions, install `package.json` dependencies, edit
`.pi/settings.json`, or reload Pi.

Codex only loads project `.codex/config.toml` in trusted projects. Capshelf
writes the project file and reports a non-failing status warning when Codex
appears likely to ignore it.

Each project gets a `.capshelf/` directory:

```text
.capshelf/
  capshelf.json        committed manifest: install mode, upstream, declared items
  capshelf.lock.json   committed lock: committed-tree digest and source commit
  local.json           gitignored: data repo path plus clone-local copy-item intent
  local.lock.json      gitignored: clone-local item pins
```

The lockfile is the safety boundary. A data item's identity is the committed
Git tree: a SHA-256 digest over the sorted `(name, mode, blobId)` entries the
data repo holds at the pinned commit. Computing it reads no file content, so
working-tree state, Git configuration, and checkout filters cannot change what
a pin means. System items bundled inside the CLI are pinned by content hash
plus CLI version.

## Mental Model

Capshelf is a declarative reconciler, not a package installer:

- `capshelf.lock.json` is the spec.
- `capshelf apply` reconciles project files to that spec.
- `capshelf status` shows the plan before anything changes.
- `capshelf update` advances selected pins to current data-repo content.
- `capshelf promote` pushes local edits back into the data repo and updates only
  the current project's lock.

That last point is the core safety property: if project A promotes a shared
skill, project B does not change until someone runs `capshelf update` there.

Capshelf also stays out of state it does not own. Skills managed by `skills.sh`,
Claude marketplace plugins, and personal `~/.claude/skills/` entries are
reported as external state instead of overwritten.

## Command Reference

| Verb | Purpose |
|---|---|
| `init` | scaffold `.capshelf/`, install bundled system items, bind a data repo |
| `set-data` | bind this machine's clone of the data repo |
| `set-upstream` | write the committed upstream URL |
| `data-path` | print the resolved local data repo path |
| `sync-data` | fetch the data repo's `origin` and fast-forward when safe; the only network command besides the `init` bootstrap clone and `self-update` |
| `ls` / `show` | inspect data repo items, installed items, and bundles; `ls` also shows user-level runtime skills by default |
| `search` | find items and bundles by name, tags, description, or content |
| `add` / `rm` | add or remove an item in this project; `add bundles/<name>` expands a bundle |
| `status` | report drift, missing files, update availability, and user-level runtime skill inventory |
| `apply` | reconcile project files to the current locks |
| `update` | bump pins to data repo HEAD, then apply |
| `share` | adopt an on-disk item into the data repo; fragments can extract unmanaged values straight from generated outputs (`--pick`) |
| `move` | move an item between local and project scope |
| `promote` | commit local edits or fragment source edits for a tracked item back to the data repo |
| `keep-local` | mark drift as intentional |
| `revert` | restore one item to its locked version |
| `get-path` | print the editable path; subagents and multi-target fragments use `--target`, and `--output` returns runtime outputs |
| `lock` | inspect this project's lock files; `lock migrate` converts the project and local locks to version 4 in one transaction — the one-way upgrade every project on lock version 2 or 3 must run once |
| `self-update` | check for and install a Homebrew update for the capshelf binary |
| `marketplace ...` | author, validate, sync, and package Claude/Cowork or Codex plugin catalogs in the data repo |

Commands support `--json` where useful for agent consumption. Exit codes are
stable: `0` success, `1` generic error, `2` not found, `3` conflict or refused
precondition, `4` drift or upstream mismatch, `5` reserved for future
unmet-requires checks, `6` no data repo configured, `7` missing or too-old
`git`. Full reference: [`docs/cli.md`](docs/cli.md).

Startup self-update prompts are best-effort, cached, and only shown for
interactive Homebrew installs. Set `CAPSHELF_NO_SELF_UPDATE=1` to disable them.

## Development

```bash
bun install
bun run src/cli.ts <verb> [args]   # run from source
bun run test                        # unit tests (4 workers)
make smoke                          # smoke suites (4 workers)
make check                          # tests plus smoke suites
make build                          # compile dist/capshelf
```

### CLI source repo

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

### Smoke-test data repo

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

## Project Status

Skills, project-local Pi extensions, Claude/Codex subagents, settings
fragments, MCP fragments, and project-scoped Codex config fragments are
implemented. Fragment outputs preserve project-local values, fragment
promotion commits canonical data repo source files rather than generated
outputs, and `share` can extract unmanaged fragment values directly from a
project's generated outputs. Item metadata (`.capshelf.yml` sidecars) drives `ls --tag`, `search`,
and `add`-time `requires`/`conflicts-with` checks. Bundles
(`capshelf add bundles/<name>`) expand curated item sets all-or-nothing with
no project-side bundle state. `validate`, `diff`, `doctor`, and `journal`
remain on the roadmap. Data-repo plugin marketplace management is implemented
for independent Claude/Cowork and Codex catalogs, including deterministic
packages and a committed native Codex projection.

## Further Reading

- [`docs/whats-new-0.8.md`](docs/whats-new-0.8.md) - what's new: Git-tree source pins, lock version 4 and `lock migrate`, filtered-content refusal, classified drift
- [`docs/whats-new-0.7.md`](docs/whats-new-0.7.md) - what's new: destructive-change consent, preserved local files, keep-local intent, init recovery
- [`docs/whats-new-0.6.md`](docs/whats-new-0.6.md) - what's new: subagents, plugin marketplaces, declared needs, stale-promote merges
- [`docs/whats-new-0.5.1.md`](docs/whats-new-0.5.1.md) - what's new: clone-local reconciliation and recovery fixes
- [`docs/whats-new-0.5.md`](docs/whats-new-0.5.md) - what's new: Pi extensions, user skill inventory, safer CLI behavior
- [`docs/whats-new-0.4.md`](docs/whats-new-0.4.md) - what's new: remote bootstrap, metadata + search, team sync, bundles
- [`docs/project-brief.md`](docs/project-brief.md) - one-page overview
- [`docs/architecture.md`](docs/architecture.md) - data model and rationale
- [`docs/cli.md`](docs/cli.md) - full command reference, flags, exit codes
- [`docs/marketplaces.md`](docs/marketplaces.md) - Claude/Cowork and Codex plugin catalogs in the data repo
- [`docs/team-workflow.md`](docs/team-workflow.md) - team loop: sync-data, propose-upstream recipe, CI drift gate
- [`docs/security.md`](docs/security.md) - trust model, threat model per item kind, guidance for teams
- [`AGENTS.md`](AGENTS.md) - guidance for coding agents working in this repo
