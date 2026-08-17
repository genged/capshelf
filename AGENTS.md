# AGENTS.md

This file gives coding agents the shared project context that should be true
for every task in this repository. Keep it concise; prefer pointers to the
living docs and source over copying long procedures here.

## Conversational Style

- Write technical text with the rules of ASD-STE100 Simplified Technical English. STE is the controlled language that aerospace and defense manufacturers use for maintenance documentation. The rules exist so that a tired reader who is not a native English speaker cannot misread an instruction. They remove the usual signs of AI-generated text as a side effect: long sentences, synonym rotation, hedges, filler, and decorative clauses.
- Write for that tired reader. Each sentence must survive one read.
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

- `bun run typecheck` runs `tsc --noEmit` (Bun does not type-check on its own).
- `bun run lint` checks formatting + lint with Biome; `bun run lint:fix` writes
  safe fixes and `bun run format` reformats only. Biome is provided in CI by the
  `biomejs/setup-biome` action; locally install it (`bunx @biomejs/biome`,
  Homebrew, or as a devDependency once the lockfile is regenerated).
- `bun run test` runs the unit test suite with four worker processes.
- `make smoke` runs all smoke tests with four worker processes.
- `make smoke-modes`, `make smoke-skills`, and `make smoke-settings` run
  focused smoke suites.
- `make check` runs typecheck, lint, the release-docs freeze check, unit
  tests, plus all smoke tests.
- `bun run src/cli.ts <verb> [args]` runs the CLI from source.
- `bun run build` or `make build` compiles `dist/capshelf`.
- `make install` builds and copies the binary to `~/.local/bin/capshelf`

For broad CLI behavior changes, run `bun run typecheck`, `bun run test`, and
the relevant smoke suite at minimum. Run `make check` before treating
cross-command or layout work as done. For a docs-only change, `git diff --check` is usually
enough.

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
  project-local settings. `promote settings/<name>` commits the fragment's
  canonical source file, `settings/<name>/settings.json`, in the data repo; the
  merged output is a product of that source, never the thing promoted.
- Treat skills managed by `skills.sh`, Claude marketplace plugins, and
  personal Claude skills as external state. Report or warn; do not co-manage.
- Keep command output scriptable. Preserve `--json`, dry-run behavior, and
  documented exit codes when extending commands.
- When changing command behavior, update the living docs in `docs/` and the
  relevant tests or smoke scripts in the same change.
- Version-specific release documentation is frozen: `docs/release-notes/*` and
  `docs/whats-new-*` describe a version that has shipped, so once committed
  they must never be edited or deleted, restores included. If the edit is not
  pushed, drop it from the commit that made it; if it is, the release is live
  — cover the change in the next version's documents. `make check` enforces
  this; `./scripts/check-release-docs-frozen.sh --audit` lists past breaches.
  What's New pages before 0.6 predate the policy and are grandfathered.

## Claims and Verification

These rules exist because a design document in this repository asserted four
things about the code that were false, each stated as confidently as the claims
that were true. A reader cannot tell the two apart, so the rules make the
difference visible instead of relying on care.

- **A claim about code carries a citation.** Any statement that the code does X
  — in a spec, a plan, a review, a commit message, or a comment — cites
  `file:line`. Anything uncited is a hypothesis and says so ("expected",
  "probably", "unverified"). This applies hardest to claims that *nothing*
  breaks: "deleting this loses nothing" needs the enumeration that shows it.
- **Verify before you depend on it.** Read the file before asserting what it
  does. A grep hit is evidence a string exists, not evidence of behavior; an
  anchored regex that finds nothing is evidence of nothing at all. When a claim
  decides a design, reproduce it — run the command, read the schema, check the
  flag in the right help text.
- **Verify claims about external tools the same way.** Versions change. Confirm
  a CLI's behavior against the installed binary, not from memory, and quote what
  it printed.
- **State the reversal.** When a verified fact overturns an earlier decision,
  record what changed and why in the document itself. Silent correction hides
  the fact that the reasoning was once wrong, which is the part a later reader
  needs most.

## Review of Design Changes

- **An adversarial review of a design needs code access.** A reviewer working
  only from a written summary produces sound abstract reasoning and misses the
  defects that live in the source. Give the reviewer the repository, or treat
  its findings as hypotheses to be checked here.
- **Check every finding against this repository before accepting it.** A
  reviewer can be wrong about the code too, and a confidently wrong finding
  applied without checking is worse than no review.
- **Preserve disagreement.** Record what was accepted, what was rejected, and
  the evidence for each. Do not manufacture consensus.

## Wide Edits

- **After a wide-ranging edit, run mechanical structure checks**, not just a
  read-through. Count section headers for duplicates, verify every relative link
  resolves, confirm code fences balance, and grep for claims the edit was
  supposed to remove. A careful read misses a duplicated section; a header count
  does not.
- **Prefer a rewrite to many overlapping edits** when a change touches most of a
  document. Sequential edits with overlapping boundaries silently leave stale
  fragments behind.

## Local-only docs

- If `local/` exists, treat it as separate, local-only context.
- Read it before large architectural changes.
- Never reference files under `local/` from source code, tests, or public docs.
- Its subfolders carry their own `INDEX.md` stating a directory policy and the
  status of each document. Read that index before adding, moving, or
  finishing a document there, and update it in the same change.

## User Override

If the user's instructions conflict with any rule in this document,
ask for explicit confirmation before overriding. Only then execute their instructions.
