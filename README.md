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

A Git-backed CLI for sharing coding-agent configuration - skills, settings,
and MCP fragments - across projects, with per-project lockfiles so a change in
one repo never disturbs work in another.

As you accumulate projects, you accumulate copies of the same skills, the same
settings overlays, the same MCP servers. Keeping them in sync by hand, or by
whole-directory symlinks, is fragile.

```bash
capshelf init --data ~/code/my-agent-data
capshelf add security-review
capshelf status
capshelf promote security-review -m "tighten SQLi check"
```

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

### 2. Create a data repo

A data repo is a normal Git repo that stores shared agent config.

```bash
mkdir -p ~/code/agent-config/skills/security-review
cd ~/code/agent-config
git init

printf '%s\n' \
  '---' \
  'name: security-review' \
  '---' \
  '' \
  'Review this change for security issues, risky shell commands, and unsafe data handling.' \
  > skills/security-review/SKILL.md

git add skills/security-review/SKILL.md
git commit -m "add security-review skill"
```

### 3. Use it in a project

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
capshelf add security-review
capshelf status
```

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

Add shared config fragments:

```bash
capshelf add settings/security-base
capshelf add mcp/github
capshelf add codex-config/defaults
capshelf get-path mcp/github --target codex
capshelf get-path mcp/github --target codex --output
```

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
git clone https://github.com/acme/agent-config ~/code/agent-config
cd ~/code/my-app
capshelf set-data ~/code/agent-config
capshelf apply
```

## What Capshelf Manages

| Kind | Data repo path                       | Project output |
|---|--------------------------------------|---|
| `skills` | `skills/<name>/SKILL.md` plus assets | `.agents/skills/<name>/` and `.claude/skills/<name>` symlink |
| `settings` | `settings/<name>/settings.json`      | merged into `.claude/settings.json` |
| `mcp` | `mcp/<name>/claude.json`, `mcp/<name>/codex.toml` | merged into `.mcp.json` and/or `.codex/config.toml` |
| `codex-config` | `codex/config/<name>/config.toml` | merged into `.codex/config.toml` |

Codex only loads project `.codex/config.toml` in trusted projects. Capshelf
writes the project file and reports a non-failing status warning when Codex
appears likely to ignore it.

Each project gets a `.capshelf/` directory:

```text
.capshelf/
  capshelf.json        committed manifest: install mode, upstream, declared items
  capshelf.lock.json   committed lock: exact content hash and source commit
  local.json           gitignored: this machine's data repo path
  local.lock.json      gitignored: clone-local item pins
```

The lockfile is the safety boundary. Data items are pinned by content hash plus
the data-repo commit that last touched the item path. System items bundled
inside the CLI are pinned by content hash plus CLI version.

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
| `ls` / `show` | inspect data repo items or installed items |
| `add` / `rm` | add or remove an item in this project |
| `status` | report drift, missing files, and update availability |
| `apply` | reconcile project files to the current locks |
| `update` | bump pins to data repo HEAD, then apply |
| `share` | adopt an on-disk item into the data repo |
| `move` | move an item between local and project scope |
| `promote` | commit local edits or fragment source edits for a tracked item back to the data repo |
| `keep-local` | mark drift as intentional |
| `revert` | restore one item to its locked version |
| `get-path` | print the editable path; skills return their directory, fragments return source files, and `--output` returns generated fragment outputs |
| `self-update` | check for and install a Homebrew update for the capshelf binary |

Commands support `--json` where useful for agent consumption. Exit codes are
stable: `0` success, `2` not found, `3` conflict, `4` drift or upstream
mismatch, `5` reserved for future unmet-requires checks, `7` missing `git`. Full reference:
[`docs/cli.md`](docs/cli.md).

Startup self-update prompts are best-effort, cached, and only shown for
interactive Homebrew installs. Set `CAPSHELF_NO_SELF_UPDATE=1` to disable them.

## Development

```bash
bun install
bun run src/cli.ts <verb> [args]   # run from source
bun test                            # unit tests
make smoke                          # smoke suites
make check                          # tests plus smoke suites
make build                          # compile dist/capshelf
```

## Project Status

Skills, settings fragments, MCP fragments, and project-scoped Codex config
fragments are implemented. Fragment outputs preserve project-local values and
fragment promotion commits canonical data repo source files, not generated
outputs. `validate`, `diff`, `doctor`, `journal`, `search`, `bundle`, and Codex
custom agent copy items are on the roadmap.

## Further Reading

- [`docs/project-brief.md`](docs/project-brief.md) - one-page overview
- [`docs/architecture.md`](docs/architecture.md) - data model and rationale
- [`docs/cli.md`](docs/cli.md) - full command reference, flags, exit codes
- [`AGENTS.md`](AGENTS.md) - guidance for coding agents working in this repo
