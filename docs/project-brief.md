# Project Brief

This project is a Bun/TypeScript CLI for managing shared agent configuration
across repositories. It is currently packaged as the `capshelf` binary and
its root command describes the job as managing shared Claude Code and Codex
configuration across projects.

The CLI lets a user keep reusable agent/project assets in a Git-backed data
repo, then materialize selected items into individual code repositories. Today
the supported item kinds are `skills`, `settings`, `mcp`, and `codex-config`.
Skills are copy items; the other kinds are JSON/TOML fragments merged into
project config outputs.

## What It Manages

Each project has a `.capshelf/` metadata directory:

- `.capshelf/capshelf.json` records the selected install mode, optional
  `dataRepoUpstream`, and the shared items this project wants.
- `.capshelf/local.json` records this machine's data repo path plus local-only
  skill intent and is ignored by `.capshelf/.gitignore`.
- `.capshelf/capshelf.lock.json` records the exact applied state for each item.
- `.capshelf/local.lock.json` records exact pins for local-only items and is
  ignored by `.capshelf/.gitignore`.

The lockfile is the safety boundary. Data items are pinned by content hash and
the last data-repo commit that touched that item path. System items are bundled
inside the CLI and pinned by content hash plus CLI version.

## Mental Model

This is closer to a declarative reconciler than a package installer. The
manifest and lock describe the desired state, and commands reconcile or report
the project filesystem against that state.

Core commands:

- `init` binds a project to a data repo and installs bundled system items.
- `add` installs an item from the data repo and records it in the manifest and
  lock.
- `status` reports local drift, upstream changes, missing files, and external
  ownership.
- `status --diff` compares current files against the locked source commit.
- `apply` converges installed files back to the lock.
- `update` advances lock entries to current upstream content and applies them.
- `share` adopts a not-yet-shared on-disk item into the data repo and tracks it
  in local or project scope.
- `move` changes an already-tracked item's scope between local and project
  without changing data-repo content.
- `keep-local` marks intentional project-local divergence.
- `revert` restores one item to its locked version.
- `promote` copies already-tracked local edits or fragment source edits back
  into the data repo, commits them, and updates only the calling project's lock.

## Git-Based Source Of Truth

Data repos must be Git repositories. The CLI uses Git to:

- verify data repo validity,
- hash Git-visible files,
- record the last touching commit for each data item,
- restore historical locked content with `git show`,
- diff current files against locked content,
- commit shared/adopted items and promoted local edits back into the data repo.

This is what makes parallel project work safe. If project A promotes a new
version of a shared skill, only project A's lock changes. If project A shares a
new skill, project B stays unchanged until it explicitly runs `add` or `update`.

## Install Layout

The default install mode is `codex-compatible`:

- real managed skills live under `.agents/skills/<name>/`,
- `.claude/skills/<name>` is a per-skill compatibility symlink.

Projects can opt into `claude-only` mode, where real skills are installed
directly under `.claude/skills/<name>/`.

Fragments from the data repo are merged into project config outputs:

- `settings/<name>/settings.json` -> `.claude/settings.json`
- `mcp/<name>/claude.json` -> `.mcp.json`
- `mcp/<name>/codex.toml` -> `.codex/config.toml`
- `codex/config/<name>/config.toml` -> `.codex/config.toml`

Existing project-local config values are preserved by removing the previous
managed contribution and applying the newly locked managed contribution on top
of the local base. Fragment commands refuse unmanaged scalar or shape
collisions instead of overwriting local values.

## Coexistence Rules

The CLI treats the lockfile as the ownership boundary. It refuses to overwrite
untracked targets and avoids co-managing skills owned by `skills.sh`. It also
reports Claude plugins and personal Claude skills as external state instead of
mutating them.

## One-Sentence Summary

This is a Git-backed CLI for sharing, scoping, pinning, diffing, updating, and
promoting reusable agent/project configuration across codebases, with
per-project lockfiles preventing shared updates from disturbing unrelated work.
