Capshelf 0.9 makes every command that describes an `mcp` or `subagents` item
say which runtimes it covers. Either kind can carry a Claude source, a Codex
source, or both, and 0.8 printed one output path for all three cases, so a
Claude-only MCP server printed `.mcp.json` and said nothing about Codex. This
release also finishes moving `add` onto the pinned commit: fragments were the
last kind whose install target set came from the data repo's working tree while
`apply` took it from the lock. The lock format is unchanged — 0.8 and 0.9 read
each other's locks, and there is no migration; run `capshelf update
skills/capshelf` once per project to pick up the refreshed bundled skill. Full
details in `docs/whats-new-0.9.md`.

## Breaking changes

- **`add` installs every fragment target the pinned commit holds.**

  It used to pick targets from the data repo's working tree while `apply` picked
  them from the lock, and the cleanliness gate cannot see a deletion that
  removes a canonical path. An `mcp` item with `codex.toml` deleted in the
  worktree was therefore accepted, pinned to a commit that still contained the
  file, and installed with only `.mcp.json` written.

  A project that depended on that behavior will now get `.codex/config.toml`
  written where 0.8 wrote only `.mcp.json`. Commit the deletion in the data repo
  if the target is genuinely retired.

- **A canonical path committed as a directory or an empty tree is refused.**

  Both used to install, save a lock, and fail in a later `apply` with a parser
  error, leaving a broken lock already on disk. They are refused at pin time
  now.

## Enhancements

- Report runtime target coverage on `add`, `show`, `status`, and `share`: every candidate target marked present or absent, with the output path it feeds and the canonical source path a missing one reads, read at the pinned commit rather than the worktree.
- Add `targetCoverage` to `add`, `show`, `share`, and every `status --json` row, carrying `present: true | false | null` plus `coverageState` when unknown; `sources`, `dst`, and the subagent `targets` array keep their existing shapes.
- Cover target coverage in the bundled `capshelf` skill, which guided agents through the `mcp` and subagent workflows without mentioning the report those commands print.

## Bug fixes

- Fire the Codex project-trust warning only when an `mcp` item's locked commit has a Codex source; it used to fire for every `mcp` item, so a Claude-only item warned about the harness it does not reach and said nothing about the one it does not cover. `codex-config` items keep the unconditional warning, and unknown coverage still warns — the gate removes a warning only on evidence.
- Prove a pinned fragment source is readable before consent, so an unreadable object no longer plans as an empty contribution and locks as a covered target.
- Stop counting a committed symlink as a covered target; Git stores one as a `blob` with mode `120000`, so filtering on object type reported it as a present source for an item capshelf refuses to pin outright.
- Report every output `rm` reconciled instead of the first, so removing a two-source `mcp` item names `.codex/config.toml` as well as `.mcp.json`.
- Fix `ls --here` rendering `undefined` in the identity column for data rows, and `add --json` and `revert --json` dropping the key entirely; `ls --here --json` gains `lockedSha`, the name `status --json` already uses.
- Stop `show` reporting `(update available)` for every item forever, including immediately after a clean `add`; it compared a content hash of the data repo's working tree against the locked pin digest, two schemes over two inputs that can never be equal. `status` owns update detection and reported these items correctly all along.
- Stop `status` exiting 1 for a whole report when one subagent's locked tree resolves but cannot be read.
- Stop `add` re-pinning after consent, so a data-repo commit landing in that window can no longer add a target the consent gate never saw.
- Correct three user-facing strings: `--kind` help omitted `subagents`, the `lock` description promised an inspect command, and the "data repo not found" error named a default path capshelf never reads.
