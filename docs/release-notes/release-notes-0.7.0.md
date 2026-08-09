Capshelf 0.7 makes destructive reconciliation ask first: `add`, `apply`,
`update`, `rm`, `revert`, and Codex marketplace sync plan the whole operation,
list the local state a write would destroy, and require consent. Ignored local
files now survive reconciliation intact, `keep-local` records intent, and
interrupted or data-repo-less states are recoverable. The lockfile schema is
unchanged, so 0.6 and 0.7 interoperate.

- Preflight destructive changes across `add`, `apply`, `update`, `rm`, `revert`, and `marketplace sync`, with typed reasons, review commands, and one prompt per run.
- Preserve ignored local-only files across a copy-item replacement with their real modes and symlinks, and treat executable mode as real drift.
- Make the `keep-local` marker mean intent: only `keep-local --unset` clears it, `revert` keeps it, and `promote` refuses a marked item.
- Recover an interrupted `init` by re-running it, and refuse a second `init` on an already-initialized machine (exit 3).
- Remove a copy item with `rm` when the data repo clone is gone or its history was rewritten.
- Make standalone `add` a byte- and lock-stable no-op for an installed item, and gate bundle installs through the same consent boundary.
- Gate config comment loss for `.codex/config.toml`, where comments are read, and announce the repairing rewrite for `.claude/settings.json` and `.mcp.json`, where they stop the file from loading.
- Read an item's source tree once per command (an 11-file item: 210 git calls to 46), emit the `--json` error envelope without ANSI color, parse `git status` with `-z`, and let `update` re-pin a system item off superseded bundled content.
- Upgrade warning: a `--json` or non-TTY run that used to overwrite local drift now exits 3 unless `--yes` authorizes the listed loss. Audit CI jobs and agent scripts before upgrading them.
