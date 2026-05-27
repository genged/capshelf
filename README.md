# capshelf

A Git-backed CLI for sharing coding-agent configuration — skills, settings,
and MCP fragments — across projects, with per-project lockfiles so a change in
one repo never disturbs work in another.

```bash
capshelf init   --data ~/code/my-agent-data
capshelf add    security-review
capshelf status
capshelf promote security-review -m "tighten SQLi check"
```

---

## What

`capshelf` materializes reusable assets from a user-owned **data repo** (a
plain Git repo) into individual code repositories.

It manages three kinds of items today:

| Kind       | Lives in data repo as            | Materializes to                            |
|------------|----------------------------------|--------------------------------------------|
| `skills`   | `skills/<name>/SKILL.md` + assets | `.agents/skills/<name>/` (+ `.claude/skills/<name>` symlink) |
| `settings` | `settings/<name>/settings.json`  | merged into `.claude/settings.json`        |
| `mcp`      | `mcp/<name>/fragment.json`       | merged into `.mcp.json` *(planned)*        |

Each project gets a `.capshelf/` metadata directory:

```
.capshelf/
├── capshelf.json        committed:  install mode, upstream, declared items
├── capshelf.lock.json   committed:  exact content hash + source commit per item
├── local.json           gitignored: this machine's data-repo path + local items
└── local.lock.json      gitignored: pins for clone-local items
```

The lockfile is the safety boundary: data items are pinned by content hash
plus the data-repo commit that last touched the path; system items (bundled
inside the CLI binary) are pinned by content hash plus CLI version.

## Why

Coding agents — Claude Code, Codex, and friends — load their behavior from
`.claude/` and `.agents/` directories living next to your source. As you
accumulate projects, you accumulate copies of the same skills, the same
settings overlays, the same MCP servers. Keeping them in sync by hand, or by
whole-directory symlinks, is fragile.

Existing options fall short:

- **Whole-directory symlinks** break the moment a project needs one local
  override.
- **Package managers** are imperative installers — they overwrite drift
  instead of surfacing it, and they assume one global version per host.
- **Dotfile managers** have no concept of "this skill belongs to project A
  but not project B," and no story for promoting a project-local edit back
  upstream.

`capshelf` is a **declarative reconciler** in the
`terraform apply` / `kubectl apply` tradition rather than an installer:

- The lockfile is the spec. `apply` is the reconciler. `status` is the plan.
- Drift is a first-class state, not a bug — `status --diff` shows it,
  `keep-local` blesses it, `revert` undoes it, `promote` pushes it upstream.
- An update in one project is **opt-in everywhere else**. `promote` writes
  only the bound data repo and the calling project's lock; other projects
  pick the change up the next time they run `capshelf update`. In-flight PRs
  elsewhere stay untouched.
- The CLI is generic. Install the binary once; point it at any data repo.

It also stays out of the way of tools it shouldn't co-manage: skills owned by
`skills.sh`, Claude marketplace plugins, and personal `~/.claude/skills/`
entries are reported as external state rather than overwritten.

## How

### Install

```bash
make install     # builds the Bun-compiled binary, copies to ~/.local/bin/capshelf
```

Make sure `~/.local/bin` is on your `PATH`. Requires [Bun](https://bun.sh)
and `git`.

### Bind a project to a data repo

```bash
# fresh project, fresh data repo:
capshelf init --data ~/code/agent-data

# project already declares an upstream, you just cloned it:
git clone https://github.com/acme/agent-data ~/code/agent-data
capshelf set-data ~/code/agent-data
capshelf apply
```

`init` writes a manifest and lock, installs bundled system items (including
the bootstrap skill that teaches agents how to use the CLI), and — by
default — sets up the `codex-compatible` install layout: real skills under
`.agents/skills/<name>/` with per-skill compatibility symlinks at
`.claude/skills/<name>`. Use `--claude-only` to install directly under
`.claude/`.

### The edit loop

```bash
capshelf add security-review              # pull a shared skill into this project
$EDITOR .agents/skills/security-review/SKILL.md

capshelf status security-review           # → drifted_local
capshelf status security-review --diff    # explain the drift

# pick one:
capshelf promote   security-review -m "..."   # push edits back to the data repo
capshelf keep-local security-review --reason  # bless this divergence
capshelf revert    security-review            # restore the locked version
```

### Adopting an existing local skill

```bash
$EDITOR .agents/skills/write-migration/SKILL.md
capshelf share skills/write-migration --to project -m "initial write-migration skill"
# → commits the skill into the data repo, tracks it in this project's manifest+lock
```

### Command surface

| Verb            | Purpose                                                                 |
|-----------------|-------------------------------------------------------------------------|
| `init`          | scaffold a project, install bundled system items, bind a data repo     |
| `set-data`      | bind this machine's clone of the data repo                              |
| `set-upstream`  | declare/change the committed upstream URL                               |
| `ls` / `show`   | inspect items in master or in this project                              |
| `add` / `rm`    | install or remove an item; `--local` for clone-local skills            |
| `status`        | drift / update report; `--diff` explains local edits; `--strict` exits 4 on drift |
| `apply`         | reconcile project files to the lock; idempotent; supports `--dry-run`  |
| `update`        | bump pins to upstream content, then apply; `--dry-run` previews         |
| `share`         | adopt a not-yet-shared on-disk item into the data repo                  |
| `move`          | change an item's scope between local and project                        |
| `promote`       | push edits for a tracked item back into the data repo                   |
| `keep-local`    | mark drift as intentional                                               |
| `revert`        | restore one item to its locked version                                  |
| `get-path`      | print the absolute path to an installed item (settings → merged JSON)   |

Every command supports `--json` for agent consumption. Exit codes are
stable: `0` success, `2` not found, `3` conflict, `4` drift / upstream
mismatch, `5` unmet requires, `7` missing `git`. Full reference:
[`docs/cli.md`](docs/cli.md).

### Development

```bash
bun install
bun run src/cli.ts <verb> [args]   # run from source, no build
bun test                            # unit tests
make smoke                          # full smoke suite (modes, skills, settings)
make check                          # tests + smoke
make build                          # compile dist/capshelf
```

## Project status

Skills and settings fragments are implemented; 

MCP fragments, `validate`, `diff`, `doctor`, `journal`, `search`, and `bundle` are on the
roadmap (see `docs/cli.md`). 

Settings fragments support `add` / `update` / `status --diff` today; 

`share`, `move`, and `promote` for settings will arrive in a later milestone.

## Further reading

- [`docs/project-brief.md`](docs/project-brief.md) — the one-page overview
- [`docs/architecture.md`](docs/architecture.md) — data model, lockfile schema, design rationale
- [`docs/cli.md`](docs/cli.md) — full command reference, flags, exit codes
- [`AGENTS.md`](AGENTS.md) — guidance for coding agents working in this repo
