# AGENTS.md

This file gives coding agents the shared project context that should be true
for every task in this repository. Keep it concise; prefer pointers to the
living docs and source over copying long procedures here.

## Conversational Style

- Keep answers short and concise 
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.

## Project

`capshelf` is a Bun/TypeScript CLI for managing shared Coding Agent
configuration across projects. It materializes user-owned skills, settings
fragments, and future MCP config from a Git-backed data repo into consuming
projects.

More info: `docs/project-brief.md`,  `docs/architecture.md`, `docs/cli.md`,

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not turn this file into a formatter or style-guide replacement. Let tests, TypeScript, and the existing code shape enforce routine style.
- Prefer zod schemas and existing helpers over ad hoc parsing or string manipulation for manifests, locks, item refs, paths, and settings JSON.

## Development Commands

- `bun test` runs the unit test suite.
- `make smoke` runs all smoke tests.
- `make smoke-modes`, `make smoke-skills`, and `make smoke-settings` run
  focused smoke suites.
- `make check` runs unit tests plus all smoke tests.
- `bun run src/cli.ts <verb> [args]` runs the CLI from source.
- `bun run build` or `make build` compiles `dist/capshelf`.
- `make install` builds and copies the binary to `~/.local/bin/capshelf`

For broad CLI behavior changes, run `bun test` and the relevant smoke suite at
minimum. Run `make check` before treating cross-command or layout work as done.
For a docs-only change, `git diff --check` is usually enough.

## Git

Multiple sessions may be running in this cwd at the same time, each modifying different files. 
Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp 
on other sessions' work. Follow these rules:

Committing:
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.

Never run (destroys other agents' work or bypasses checks)

If rebase conflicts occur:
- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Project Specific

- Do not hand-edit `capshelf.lock.json` unless the task is explicitly about
  lockfile fixtures or migration behavior. The lock is tool-managed state.
- Keep the system/data distinction intact. System items are bundled in
  `src/bundled/` and versioned by CLI version; data items live in a data repo
  and are pinned by content hash plus `sourceCommit`.
- Data repos must be Git repos. `add`, `update`, `apply`, `revert`, and
  `promote` rely on `git log`, `git show`, `git ls-tree`, and clean working
  trees so a lock entry can be restored later.
- Preserve opt-in update safety. A promote from one project must not mutate
  another project; other projects only change when they run `capshelf update`.
- Settings fragments merge into `.claude/settings.json` while preserving
  project-local settings. `promote settings/<name>` is intentionally rejected
  until fragment promotion exists.
- Treat skills managed by `skills.sh`, Claude marketplace plugins, and
  personal Claude skills as external state. Report or warn; do not co-manage.
- Keep command output scriptable. Preserve `--json`, dry-run behavior, and
  documented exit codes when extending commands.
- When changing command behavior, update the living docs in `docs/` and the
  relevant tests or smoke scripts in the same change.

## Local only docs

If `local/` exists locally, it is a separate local only directory.
Read `local/` before large architectural changes.
Do not create public references that require `local/` to exist.

## User Override

If the user's instructions conflict with any rule in this document, 
ask for explicit confirmation before overriding. Only then execute their instructions.