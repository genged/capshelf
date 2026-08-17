# What's new in capshelf 0.9

Capshelf 0.9 makes every command that describes an `mcp` or `subagents` item
say which runtimes that item actually covers. An item of either kind can carry
a Claude source, a Codex source, or both. Capshelf 0.8 printed one output path
for all three cases, so installing a Claude-only MCP server printed the path to
`.mcp.json` and said nothing about Codex. That file is not a neutral fact: it is
Claude Code's project MCP file.

The release also finishes moving `add` off the data repo's working tree.
Fragments were the last kind whose install target set came from the worktree
while `apply` took it from the lock. That gap let `add` write half an item and
report success.

The lock format is unchanged. Capshelf 0.8 and 0.9 read each other's locks, and
there is no migration this time.

## Do I need to do anything?

| If you | Then |
|---|---|
| track `mcp` or `subagents` items | No, but `status` now names any runtime an item does not cover |
| script against `--json` | Read [the new `targetCoverage` key](#coverage-in-json-output); it is additive, and `sources` and `dst` are unchanged |
| have projects on capshelf 0.8 | Run `capshelf update skills/capshelf` once per project to pick up the refreshed bundled skill |
| are on capshelf 0.7 or older | Run `capshelf lock migrate` first. See [What's new in 0.8](whats-new-0.8.md) |

## Every command names the runtimes an item covers

`add` prints a target block in place of a single output path. The block prints
whether or not there is a gap, because a table that appears only on failure
teaches nothing:

```console
$ capshelf add subagents/reviewer
✓ added project/data/subagents/reviewer @ 4df7346b111e
  source commit: df9654c528c758d739ccef9c6ae7cf7a2fdde3c2
  targets:
    Claude  written  /home/agent/code/my-app/.claude/agents/reviewer.md
    Codex   written  /home/agent/code/my-app/.codex/agents/reviewer.toml
```

When a source is missing, the block names the canonical path that target reads
and what to do about it:

```console
$ capshelf add subagents/claude-only
✓ added project/data/subagents/claude-only @ d2c92b37f47f
  source commit: df9654c528c758d739ccef9c6ae7cf7a2fdde3c2
  targets:
    Claude  written  /home/agent/code/my-app/.claude/agents/claude-only.md
    Codex   absent   no codex source in this item
  Codex reads subagents/claude-only/codex.toml in your data repo.
  Once it is committed there: capshelf update subagents/claude-only
```

`status` is a whole-project overview, so it stays silent on full coverage and
prints one sub-line per item that has a gap:

```console
$ capshelf status
project/
  ✓   data/mcp/github                         2b7041f66a52  up-to-date
      targets: Claude ✓  Codex ✗ — no codex source at the locked commit
        Codex reads mcp/github/codex.toml; once it is committed there: capshelf update mcp/github
```

`show` reports the same block for an installed item, read at the commit that
project pinned, and `share` prints it for the item it just committed — so a
share that creates only `claude.json` names the Codex source it did not author.

A gap is a fact, not a fault. Capshelf has no project-level declaration of
which harnesses you use, so a one-target item is a valid install: the exit code
stays 0, there is no `⚠` glyph, and `--strict` is unaffected.

Coverage is read at a commit, never at the worktree, so an unbound data repo or
an unreachable commit means capshelf cannot say which sources existed. It says
so instead of guessing, and reports no gap in that state:

```console
$ capshelf status mcp/github
project/
  !   data/mcp/github                         2b7041f66a52  locked sourceCommit 3dd7a91 is not present in the data repo
      targets: unknown (locked commit unreachable)
```

## Add a source for the missing runtime

The gap line names a canonical path, never a computed repair command, so it
holds whether the source is missing everywhere, present at `HEAD` but not at
the locked commit, or present only in the data repo's working tree. Author the
file there, commit it, then update the projects that want it:

```console
$ capshelf update subagents/claude-only
✓ project/data/subagents/claude-only updated
  current: 43a971976f30
  locked: d2c92b37f47f
  planned: d96d67c300bd
  source commit: cc0dc0d3f5003b197fe1dbeb4031a3e3efdeec41

$ capshelf status subagents/claude-only
project/
  ✓   data/subagents/claude-only              d96d67c300bd  up-to-date
```

`update` prints no target block of its own, so confirm with `status`. To ask
about one runtime directly, `capshelf show <item> --target codex` exits 3 and
prints the same guidance — with a distinct message when the source is committed
but merely deleted in your working tree, where authoring it again would be the
wrong repair.

## Coverage in JSON output

`add`, `show`, `share`, and every `status` row gain a `targetCoverage` array —
one entry per candidate target, present or not. From
`capshelf status mcp/github --json`:

```json
"targetCoverage": [
  { "target": "claude", "present": true,  "sourcePath": "mcp/github/claude.json", "outputPath": ".mcp.json" },
  { "target": "codex",  "present": false, "sourcePath": "mcp/github/codex.toml",  "outputPath": ".codex/config.toml" }
]
```

The key is additive. `sources` keeps its present-only shape, `dst` keeps its
value, and the subagent `targets` array in `status --json` is untouched, so
existing consumers are unaffected. Filter `targetCoverage` on `present` instead
of reading `sources`. When coverage cannot be read, every `present` is `null`
and the row carries `"coverageState": "unknown"` with a `coverageReason`.

`settings/<name>` and `codex-config/<name>` have one candidate target each and
are unchanged: no block, and no `targetCoverage` key.

## `add` writes the item it pinned

`add` used to choose which fragment targets to write by looking at the data
repo's working tree, while `apply` chose them from the lock. The cleanliness
gate cannot see a deletion that removes a canonical path, so an `mcp` item with
`codex.toml` deleted in the worktree was accepted, pinned to a commit that
still contained the file, and installed with only `.mcp.json` written. The
install stayed incomplete until an unrelated `apply` finished it from the same
lock entry.

Both the install loop and the consent plan now read the pinned commit:

```console
$ rm ~/code/agent-config/mcp/deepwiki/codex.toml    # deleted in the worktree only

$ capshelf add mcp/deepwiki
✓ added project/data/mcp/deepwiki @ d75c84942658
  source commit: 2ed7aa0e666a09dc68e40581c10cd93ae50004e9
  targets:
    Claude  written  /home/agent/code/my-app/.mcp.json
    Codex   written  /home/agent/code/my-app/.codex/config.toml
```

The consented target set and the written target set are now the same set. That
matters beyond completeness: TOML comment loss is gated rather than announced,
so a target written outside the consent gate could have rewritten an existing
`.codex/config.toml` silently.

## `add` refuses a source it cannot materialize

Several shapes used to pass `add`, save a lock, and fail later in `apply` with
a parser error — a broken lock already on disk. They are refused at pin time
now:

- **A canonical path committed as a directory.** `git show <commit>:mcp/<n>/codex.toml`
  resolved to a tree listing and was handed to the TOML parser.
- **A canonical path committed as an empty tree.** `git ls-tree -r` emits
  nothing for one, so a descendant scan could not see it at all.
- **A pinned blob that does not read.** `add` proves every pinned fragment
  source is readable before it asks for consent, so an unreadable object no
  longer plans as an empty contribution and locks as a covered target. Coverage
  confirms it too, and degrades the report to `unknown` rather than claiming a
  runtime is covered while `apply` cannot restore it.

## Smaller improvements

- **`ls --here` prints identities again.** Lock version 4 replaced a data
  entry's `sha` with `sourcePinDigest`, and several display paths still read
  `sha`, so every data row rendered the literal text `undefined` in the
  identity column while system rows looked fine. `ls --here --json` also gains
  `lockedSha`, the name `status --json` already uses.
- **`show` no longer claims every item has an update.** It compared a content
  hash of the data repo's working tree against the locked pin digest — two
  schemes over two inputs that can never be equal — so it reported
  `(update available)` forever, including immediately after a clean `add`. The
  claim is withdrawn: `status` owns update detection.
- **`add --json` and `revert --json` stop dropping the identity key.**
  `JSON.stringify` omits an undefined value, so a script saw no field rather
  than an error.
- **`add` pins once, not three times.** The install used to re-pin after
  consent and write whatever that tree contained, so a data-repo commit landing
  in that window could add a target the consent gate never saw.
- **`status` degrades instead of aborting.** A subagent whose locked tree
  resolves but does not read used to exit 1 for the whole report.
- **`rm` reports every output it reconciled, not the first.** Removing a
  two-source `mcp` item said it had updated `.mcp.json` and stayed silent about
  `.codex/config.toml`.
- **A committed symlink no longer counts as a covered target.** Git stores one
  as a `blob` with mode `120000`, so filtering on object type reported a
  symlinked `codex.toml` as a covered Codex source — for an item capshelf
  refuses to pin outright.
- **The Codex project-trust warning is gated on evidence.** It used to fire for
  every `mcp` item, so a Claude-only item warned about the harness it does not
  reach and said nothing about the one it does not cover. An `mcp` item now
  warns only when its locked commit has a Codex source. `codex-config` items
  keep the unconditional warning, and unknown coverage still warns — the gate
  removes a warning only on evidence, so a degraded project never loses one.
- **`ls --kind` and `search --kind` list `subagents`.** The help text was
  hand-copied from the kind list and had omitted it, though the filter always
  accepted it.
- **The `capshelf lock` description no longer promises an inspect command.**
  `lock migrate` is the only subcommand.
- **The "data repo not found" error stops naming a path capshelf never reads.**
  It suggested creating `~/code/capshelf-data`; there is no implicit default,
  so nothing would have looked there. It now names `--data`, `data bind`, and
  `$CAPSHELF_HOME`.
- **The bundled `capshelf` skill covers target coverage.** It guided agents
  through the `mcp` and subagent workflows without mentioning the report those
  commands print.

## Breaking changes

- **`add` installs every fragment target in the pinned commit.** A project that
  depended on the old behavior — a worktree deletion suppressing one output —
  will now get `.codex/config.toml` written where 0.8 wrote only `.mcp.json`.
  Commit the deletion in the data repo if the target is genuinely retired.
- **Items with a directory or an empty tree at a canonical path are refused.**
  They previously installed and produced an unusable lock.

## Upgrading

No lock migration. The lock format is version 4 in both 0.8 and 0.9, so the two
interoperate and nothing has to be upgraded in a particular order.

```bash
capshelf self-update          # Homebrew installs
```

The bundled `capshelf` skill changed, so every project that tracks it reports
an available update once the new binary is in place:

```console
$ capshelf status skills/capshelf
project/
  ⚠   system/skills/capshelf                  44ca0b29487a  update available → aeb97bf2b397 (cli upgraded)

$ capshelf update skills/capshelf
✓ project/system/skills/capshelf updated
```

Then run `capshelf status` to review coverage across the project: any `mcp` or
`subagents` item that reaches only one runtime is now named.
