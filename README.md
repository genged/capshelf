<p align="center">
  <img src="docs/logo.png" alt="Capshelf logo" width="200" />
</p>
<h1 align="center">Capshelf</h1>
<h3 align="center">Shared coding-agent config, pinned per project — a change in one repo never disturbs another until that repo asks for it</h3>
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
extensions, subagents, settings, and MCP fragments — across projects, with a
lockfile per project.

As you accumulate projects, you accumulate copies of the same skills, the same
settings overlays, the same MCP servers. Copy them by hand and every project
drifts out of date. Symlink the whole directory and an edit for one project
silently changes all of them, with no diff and no way to keep a local variant.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagram-flow-dark.svg">
    <img src="docs/diagram-flow-light.svg" width="900"
      alt="One Git data repo holds shared skills, Pi extensions, subagents, and config fragments. The project my-app adds an item, edits it, and promotes the edit back to the data repo, which commits locally and never pushes. The project other-app still holds the version it pinned; capshelf status reports that a newer version exists, and no file there changes until someone runs capshelf update." />
  </picture>
</p>

The recording below runs that loop. `other-app` installs a shared skill from
the picker. `my-app` edits its copy and promotes the edit. `other-app` keeps
its pin until it runs `capshelf update`. The transcript after the recording
shows the same sequence as text.

<p align="center">
  <img src="docs/demo/demo.gif" width="900"
    alt="A terminal recording. In other-app, capshelf add opens the picker, the query secrev selects security-review, and Enter installs it. In my-app, an edit to the skill shows as drift in capshelf status --diff, and capshelf promote commits it to the data repo. Back in other-app, capshelf status reports an update available, and capshelf update moves the pin." />
</p>

Two projects, `my-app` and `other-app`, both using a shared `security-review`
skill. `other-app` installs it from the data repo:

```console
$ cd ~/code/other-app
$ capshelf add security-review
✓ added project/data/skills/security-review @ 79402231469b
  source commit: 0d70263c55801ad4bb06206d9f91f7fbd520ca9a
  /home/agent/code/other-app/.agents/skills/security-review
```

`my-app` edits its copy. `status` names the kind of drift and shows it:

```console
$ cd ~/code/my-app
$ echo '- parameterized queries assumed; flag every f-string in a query' >> "$(capshelf get-path security-review)/SKILL.md"
$ capshelf status security-review --diff
/home/agent/code/my-app  (1 item)

project/
  ✎   data/skills/security-review             79402231469b  drifted (1 file: content-edit)

diff project/data/skills/security-review [locked -> installed]
--- SKILL.md (locked 0d70263)
+++ SKILL.md (installed)
@@ -8,3 +8,4 @@ Check every changed handler for:
 - SQL built by string concatenation
 - endpoints with no authorization check
 - secrets read from source instead of the environment
+- parameterized queries assumed; flag every f-string in a query
```

`promote` commits that edit to the data repo. It never pushes:

```console
$ capshelf promote security-review -m "tighten SQLi check"
✓ promoted data/skills/security-review @ cf20921dc2d493caa2dc9eab4c73cce4608e17dd8e494faaa2db3b49f0529f5b
  source commit: 50bebc39ea903ce11ce61958bfed4650f758a99a

committed to local data repo:
  ~/code/agent-config

to share upstream:
  cd ~/code/agent-config
  git push
```

`other-app` is untouched. It still holds the version it pinned, and is told a
newer one exists:

```console
$ cd ~/code/other-app
$ capshelf status security-review
/home/agent/code/other-app  (1 item)

project/
  ⚠   data/skills/security-review             79402231469b  update available → cf20921dc2d493caa2dc9eab4c73cce4608e17dd8e494faaa2db3b49f0529f5b
```

Its files change only when someone runs `capshelf update` there.

## Quickstart

### 1. Install Capshelf

```bash
brew install genged/tap/capshelf
```

Capshelf also needs `git` 2.40 or newer on your `PATH`.

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

### 2. Create the data repo

The data repo is a second Git repo, separate from every project that uses it.
Create it once. Every project you connect later reads from it.

```bash
mkdir -p ~/code/agent-config
cd ~/code/agent-config
git init
git remote add origin https://github.com/acme/agent-config
git commit --allow-empty -m "initialize shared agent config"
```

It starts empty. Step 3 fills it.

`init` reads that `origin` and records it as `dataRepoUpstream`, so future
clones discover the same source. Point it at a repo you can push to. For a
machine-local sandbox with no remote, add `--no-upstream` to the `init` command
in the next step.

### 3. Connect a project

Bind the project, then look at what is on the shelf:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
capshelf ls
```

The shelf is empty, so fill it. Move a skill this project already has into the
data repo; capshelf commits it there and tracks it here:

```bash
capshelf share skills/security-review --to project \
  -m "share existing security-review skill"
capshelf status
```

That works for any skill under `.agents/skills/<name>/` or
`.claude/skills/<name>/`. Repeat it from each repository holding skills you want
to centralize.

No skills anywhere yet? Create one, so the loop has something to carry:

```bash
mkdir -p .agents/skills/hello
cat > .agents/skills/hello/SKILL.md <<'EOF'
---
name: hello
description: Smoke test. Confirms capshelf is installed and a data repo is bound.
---

Reply with "capshelf is working".
EOF
capshelf share skills/hello --to project -m "add hello skill"
capshelf status
```

Either path ends the same way. `status` lists the shared skill next to the
system skill that `init` installed:

```console
$ capshelf status
/home/agent/code/my-app  (2 items)

project/
  ✓   system/skills/capshelf                  aeb97bf2b397  up-to-date
  ✓   data/skills/security-review             79402231469b  up-to-date
```

By default, skills are installed under `.agents/skills/<name>/` and exposed to
Claude through `.claude/skills/<name>` symlinks. Use `capshelf init
--claude-only --data <repo>` if a project should write real skill directories
directly under `.claude/skills/`.

### Two repos, side by side

After step 3 you have both. A data repo holds items at the top level; a project
holds `.capshelf/` pins and the installed copies:

```text
~/code/agent-config/                 the data repo
  skills/security-review/SKILL.md
  mcp/github/claude.json

~/code/my-app/                       a project that uses it
  .capshelf/                         manifest and lock
  .agents/skills/security-review/    installed copy
```

Capshelf accepts a project's own path as `--data` and reports success. That
makes the project its own shelf, private to itself. Keep the two separate.

One data repo serves many projects. You can keep more than one — a work shelf
and a personal shelf, say — and bind each project to the one it needs.

### Joining a data repo that already has items

If your team already runs one, skip step 2 and bind to your clone of it:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-shared
capshelf status
```

`init` ends by showing you the shelf. Type to filter it, press `tab` to mark
each item you want, and press `enter` to install them. Press `esc` to skip. The
project is already initialized either way. Run `capshelf add` with no arguments
to open the same list again later.

Use `add` for an item the data repo already holds, and `share` to move one up
there for the first time.

## Support matrix - Capabilities and Harnesses

| Item kind | Claude Code | Codex CLI | Cowork / claude.ai | Pi |
|---|:---:|:---:|:---:|:---:|
| Skills | ✓ `.claude/skills/` ᵇ | ✓ `.agents/skills/` | ✓ ᵃ | ✗ |
| Subagents | ✓ `.claude/agents/` | ✓ `.codex/agents/` | ✗ | ✗ |
| Settings | ✓ `.claude/settings.json` ᵈ | ✓ `.codex/config.toml` ᵈ | ✗ | ✗ |
| MCP fragments | ✓ `.mcp.json` | ✓ `.codex/config.toml` | ✗ | ✗ |
| Pi extensions | n/a | n/a | n/a | ✓ `.pi/extensions/` |
| Plugin catalogs | ✓ authored ᶜ | ✓ generated projection | ✓ `.plugin` pack upload | ✗ |

## Examples

Add a shared skill:

```bash
capshelf add                 # pick from the shelf interactively
capshelf ls                  # or browse it
capshelf show security-review --no-content
capshelf add security-review # or name the item
```

The picker filters as you type, and it matches loose subsequences rather than
substrings: `secrev` finds `security-review`. `tab` marks a row, and `enter`
installs every marked row. A menu across the top selects the item type, and
`left` and `right` move between types.

Edit a skill locally, then choose what to do with the drift:

```bash
$EDITOR "$(capshelf get-path security-review)/SKILL.md"
capshelf status security-review --diff

capshelf promote security-review -m "tighten security review checklist"
# or:
capshelf keep-local security-review --reason "project-specific review rules"
# or, discarding the edit:
capshelf revert security-review --yes         # or answer y at the prompt
```

Adopt a project-local skill into the shared data repo:

```bash
mkdir -p .agents/skills/write-migration
$EDITOR .agents/skills/write-migration/SKILL.md
capshelf share skills/write-migration --to project -m "add write-migration skill"
```

`capshelf share` with no item opens the picker instead. It finds untracked
skills, Pi extensions, subagents, and unmanaged config values, and adopts the
rows you mark. `capshelf promote` with no item opens the same kind of picker
over the tracked items.

Config fragments, `--pick` extraction, Pi extensions, subagents, and bundles
have worked examples in [`docs/cli.md`](docs/cli.md); plugin marketplaces in
[`docs/marketplaces.md`](docs/marketplaces.md).

`capshelf init --data <remote-url>` bootstraps a project straight from a
shared data repo URL, and plain `capshelf init` connects a freshly cloned
project through its committed `dataRepoUpstream` — both are worked through
in [`docs/cli.md`](docs/cli.md) under Getting started.

## What Capshelf manages

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/diagram-kinds-dark.svg">
    <img src="docs/diagram-kinds-light.svg" width="900"
      alt="Skills, Pi extensions, and subagents are copied from the data repo into project files. Settings, MCP, and Codex config fragments are merged into .claude/settings.json, .mcp.json, and .codex/config.toml, which keep their project-local entries." />
  </picture>
</p>

| Kind | Data repo path                       | Project output |
|---|--------------------------------------|---|
| `skills` | `skills/<name>/SKILL.md` plus assets | `.agents/skills/<name>/` and `.claude/skills/<name>` symlink |
| `pi-extensions` | `pi/extensions/<name>/index.ts` plus local modules | `.pi/extensions/<name>/` |
| `subagents` | `subagents/<name>/claude.md`, `subagents/<name>/codex.toml` | `.claude/agents/<name>.md` and/or `.codex/agents/<name>.toml` |
| `settings` | `settings/<name>/settings.json`      | merged into `.claude/settings.json` |
| `codex-config` | `codex/config/<name>/config.toml` | merged into `.codex/config.toml` |
| `mcp` | `mcp/<name>/claude.json`, `mcp/<name>/codex.toml` | merged into `.mcp.json` and/or `.codex/config.toml` |

Pi extensions can use committed project scope or clone-local Capshelf scope;
both materialize to Pi's project-local `.pi/extensions/<name>/` path and execute
arbitrary code after Pi project trust. Capshelf reports that warning.

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
  .gitignore           written by capshelf: the rule that ignores those two files
```

The lockfile is the safety boundary. A data item's identity is the committed
Git tree: a SHA-256 digest over the sorted `(name, mode, blobId)` entries the
data repo holds at the pinned commit. Computing it reads no file content, so
working-tree state, Git configuration, and checkout filters cannot change what
a pin means. System items bundled inside the CLI are pinned by content hash
plus CLI version.

### What Capshelf leaves alone

Capshelf writes the files it owns and reports on the rest. These stay with you
or with the runtime:

- Pi extension sandboxing, `package.json` dependencies, `.pi/settings.json`,
  and reloading Pi.
- Registering, installing, refreshing, and removing runtime plugins. Capshelf
  creates and commits the catalog state those runtimes read.
- Skills managed by `skills.sh`, Claude marketplace plugins, and personal
  `~/.claude/skills/` entries. Capshelf reports them as external state.

## Mental model

Capshelf is a declarative reconciler, not a package installer:

- `capshelf.lock.json` is the spec.
- `capshelf apply` reconciles project files to that spec.
- `capshelf status` shows the plan before anything changes.
- `capshelf update` advances selected pins to current data-repo content.
- `capshelf promote` pushes local edits back into the data repo and updates only
  the current project's lock.

That last bullet is why the transcript above works: project B keeps its pin
until someone runs `capshelf update` there.

## What a human still does

1. Approve a `promote` when the agent surfaces it.
2. Glance at `capshelf status` when starting a project.
3. Make project-specific policy decisions for new projects.

Everything else — inspect, edit, share, move, promote, and reconcile — is
the agent's job. `search`, item metadata, and bundles give agents the
discovery loop; the interactive picker gives humans theirs.

## Command reference

The verbs: `init`, `add`, `rm`, `status`, `apply`, `update`, `share`,
`move`, `promote`, `keep-local`, `revert`, `get-path`, `ls`, `show`,
`search`, `lock migrate`, `self-update`, the `data` subcommands, and the
`marketplace` family. Commands support `--json` where useful for agent
consumption, and exit codes are stable. The full table with flags, JSON
shapes, and exit codes is in [`docs/cli.md`](docs/cli.md).

Startup self-update prompts are best-effort, cached, and only shown for
interactive Homebrew installs. Set `CAPSHELF_NO_SELF_UPDATE=1` to disable them.

## Development

```bash
bun install
bun run src/cli.ts <verb> [args]   # run from source
bun run test                       # unit tests (4 workers)
make smoke                         # smoke suites (4 workers)
make e2e                           # build dist/capshelf, then run the e2e suite
make check                         # typecheck, lint, docs freeze, tests, smoke, e2e
make build                         # compile dist/capshelf
```

The end-to-end suite, and therefore `make check`, also needs `python3` on
your `PATH` for the terminal cells.

The recording at the top of this page is `docs/demo/demo.gif`. To record it
again, run `./docs/demo/setup.sh`, then `vhs docs/demo/demo.tape` from the
repository root. The setup script builds a sandbox under `/tmp/capshelf-demo`
and compiles the binary the tape runs. Recording needs
[VHS](https://github.com/charmbracelet/vhs).

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
├── tests/                          unit tests
├── e2e/                            end-to-end suite
├── scripts/                        smoke tests and release scripts
├── package.json
├── Makefile
├── docs/                           living docs
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

## Project status

| Capability | State | Reference |
|---|---|---|
| Skills, project-local Pi extensions, Claude/Codex subagents | shipped | [item kinds](docs/cli.md#item-kinds) |
| Settings, MCP, and project-scoped Codex config fragments | shipped | [config fragments](docs/cli.md#config-fragments) |
| Bundles — curated item sets, expanded all-or-nothing | shipped | [bundles](docs/cli.md#bundles) |
| Item metadata driving `ls --tag`, `search`, and `requires`/`conflicts-with` | shipped | [item metadata](docs/cli.md#item-metadata) |
| Claude/Cowork and Codex plugin catalogs in the data repo | shipped | [plugin marketplaces](docs/cli.md#plugin-marketplaces) |
| `validate`, `diff`, `doctor`, `journal` | roadmap | — |

Fragment behavior to know before you adopt them:

- Fragment outputs preserve project-local values.
- `promote` commits the fragment's canonical source file in the data repo. The
  generated output is a product of that source.
- `share --pick` extracts an unmanaged value straight from a project's
  generated output.

Bundles expand at install time. Members become independent items, and the lock
records each member on its own.

## Further reading

- [`docs/cli.md`](docs/cli.md) - full command reference, flags, exit codes
- [`docs/architecture.md`](docs/architecture.md) - data model and rationale
- [`docs/team-workflow.md`](docs/team-workflow.md) - team loop: `data sync`, propose-upstream recipe, CI drift gate
- [`docs/security.md`](docs/security.md) - trust model, threat model per item kind, guidance for teams
- [`docs/marketplaces.md`](docs/marketplaces.md) - Claude/Cowork and Codex plugin catalogs in the data repo
- [`docs/testing.md`](docs/testing.md) - the four test layers and the rules the harness enforces
- [`AGENTS.md`](AGENTS.md) - guidance for coding agents working in this repo

### Release history

- [`docs/whats-new-0.11.md`](docs/whats-new-0.11.md) - interactive pickers for setup, sharing, and promotion, plus publication previews
- [`docs/whats-new-0.10.md`](docs/whats-new-0.10.md) - `update --merge`, both diff views in `status --diff`, complete file-tree diffs, end-to-end suite
- [`docs/whats-new-0.9.md`](docs/whats-new-0.9.md) - runtime target coverage for mcp and subagents, pin-sourced fragment installs, gated Codex trust warning
- [`docs/whats-new-0.8.md`](docs/whats-new-0.8.md) - Git-tree source pins, lock version 4 and `lock migrate`, filtered-content refusal, classified drift
- [`docs/whats-new-0.7.md`](docs/whats-new-0.7.md) - destructive-change consent, preserved local files, keep-local intent, init recovery
- [`docs/whats-new-0.6.md`](docs/whats-new-0.6.md) - subagents, plugin marketplaces, declared needs, stale-promote merges
- [`docs/whats-new-0.5.1.md`](docs/whats-new-0.5.1.md) - clone-local reconciliation and recovery fixes
- [`docs/whats-new-0.5.md`](docs/whats-new-0.5.md) - Pi extensions, user skill inventory, safer CLI behavior
- [`docs/whats-new-0.4.md`](docs/whats-new-0.4.md) - remote bootstrap, metadata + search, team sync, bundles
