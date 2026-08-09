# What's new in capshelf 0.7

Capshelf 0.7.0 makes destructive reconciliation ask first. `add`, `apply`,
`update`, `rm`, `revert`, and Codex marketplace sync now plan the complete
operation before the first write, list the local state the write would destroy,
and ask once. Around that boundary, ignored local-only files survive
reconciliation with their real modes and symlinks, the `keep-local` marker
records intent instead of content state, an interrupted `init` is recoverable
by re-running it, and `rm` works when the data repo clone is gone.

The lockfile schema is unchanged — still version 3 — so 0.6 and 0.7 read each
other's locks. The compatibility break is behavioral: a `--json` or non-TTY run
that previously overwrote local drift now refuses with exit 3 unless `--yes`
authorizes the listed loss. Update CI jobs and agent scripts before upgrading
them.

## Review before capshelf overwrites local state

Reconciliation used to overwrite an edited item without comment. Six commands
now share one preflight: they complete the whole operation read-only, emit
typed change records, and stop.

```bash
capshelf apply skills/hello
```

```text
✗ Apply would destroy local state:
  project/data/skills/hello — .agents/skills/hello/scratch.txt — delete a local-only path
  project/data/skills/hello — .agents/skills/hello/SKILL.md — overwrite managed content
  Review local changes with:   capshelf status skills/hello --diff
  Rerun with `capshelf apply skills/hello --yes` to authorize the listed loss.
```

Review the drift, then authorize it:

```bash
capshelf status skills/hello --diff
capshelf apply skills/hello --yes
```

On an interactive terminal the same list is followed by `Continue? [y/N]`.
Declining exits 0 and writes nothing. With `--json`, in CI, or on any non-TTY,
capshelf does not prompt: it refuses with exit 3 and puts the list in the error
envelope, so `--yes` is a deliberate authorization rather than a silent
default. Capshelf revalidates the reviewed snapshot immediately before writing;
if the tree changed after you consented, the command aborts without writing.

Dry runs never prompt and report the same plan:

```bash
capshelf update skills/hello --dry-run --json
```

```json
{
  "items": [{ "key": "data/skills/hello", "action": "would-update" }],
  "destructiveChanges": [
    {
      "scope": "project",
      "item": "project/data/skills/hello",
      "path": ".agents/skills/hello/SKILL.md",
      "reason": "managed_content",
      "reviewCommand": "capshelf status skills/hello --diff"
    }
  ]
}
```

Seven reasons exist, and each one is emitted by a planner: `managed_content`,
`executable_mode`, `extra_local_path`, `subagent_target`,
`fragment_contribution`, `config_comments`, and `dirty_projection`. A test
asserts that every declared reason is both documented and emitted, so an
unimplemented branch of the boundary cannot read as implemented.

`--yes` authorizes only the enumerated loss. It does not bypass path safety,
source cleanliness, fragment collisions, stale-promote protection, or
transaction checks. `add` over a pre-existing unmanaged target is still a hard
refusal with no force flag.

## Keep local-only files that live inside a managed directory

Reconciliation replaces a copy item's whole tree, and it now distinguishes
Git-visible drift from local state. Ignored files are carried across the
replacement with their real filesystem modes, and symlinks are recreated by
target instead of throwing:

```bash
printf 'node_modules/\n' > .agents/skills/hello/.gitignore
npm --prefix .agents/skills/hello install    # symlinks under node_modules/.bin
capshelf apply skills/hello --yes
ls .agents/skills/hello/node_modules         # still there, untouched
```

Previously the first symlink made the item impossible to apply, update, revert
or remove while `status` still reported it up-to-date, and every preserved file
was rewritten to mode 0644 or 0755 — silently widening an owner-only
`.env.local`. Git's two-mode object model now stops at the data-repo boundary,
where it belongs. Fifos, sockets, and device nodes are still refused on write
and listed on removal.

An item's `.capshelf.yml` sidecar finally has a defined position: it is
excluded from hashing and materialization everywhere, and treated as local
state during reconciliation. A project-authored sidecar used to read as
permanent drift — `status` said up-to-date, `apply` said it would destroy
state, and `apply` never converged.

Executable bits are now first-class. A mode-only edit is real drift, is
promotable, and shows up as `executable_mode` when a write would replace it.

## `keep-local` records intent, not content state

The marker used to be cleared exactly where it was most justified — `revert` on
a drifted item destroyed it, while a marker that provably matched upstream
survived. One rule now: only `keep-local` sets it, only `keep-local --unset`
clears it.

```bash
capshelf keep-local skills/hello --reason "project-specific tweak"
capshelf apply skills/hello
```

```text
• project/data/skills/hello kept local
  project-specific tweak
  clear a keep-local marker to have it reconciled again: capshelf keep-local skills/hello --unset
```

`revert` is the explicit override: it restores the pinned content behind the
consent gate and keeps the marker, so you can reset to the pinned base and
start a fresh edit without losing the intent.

```bash
capshelf revert skills/hello --yes
```

```text
✓ reverted data/skills/hello
  keep-local marker kept (project-specific tweak)
  clear it with: capshelf keep-local skills/hello --unset
```

`revert` never rewrites the lock. An unmarked, undrifted item reports
`= already current` and stays quiet. `promote` refuses a marked item with exit
3 — publishing the divergence would end it — and prints the `--unset` and
`promote` pair in order. `update` and `data sync` carry the marker across a
lock refresh, so upstream movement cannot silently revoke it.

## Recover an interrupted init, and stop re-running a finished one

`init` refuses a project that is already initialized on this machine, keyed on
`.capshelf/local.json` — but it used to write that file before the lock. An
interruption between the two left `init` refusing while `apply` reported
nothing tracked, with the system items on disk unmanaged and no supported way
out.

`local.json` is now written last, so the file the guard checks is also the
completion marker, and a plain re-run is the recovery:

```bash
capshelf init --data ~/code/agent-config
```

The re-run adopts a leftover system item when its content matches the running
binary exactly. A leftover from a different capshelf version, or a torn write,
still refuses and names the path — and deleting that directory is safe, because
`init` reinstalls system items from the binary.

Re-running a finished `init` is now a refusal rather than a second
initialization:

```text
✗ capshelf is already initialized for this machine at /path/to/project
  init is only for new projects or fresh clones without .capshelf/local.json.
  use 'capshelf data bind <path>' to change the local data repo,
  use 'capshelf data upstream <url>' to change its committed upstream, or
  use 'capshelf update' to update managed items.
```

It exits 3 before capshelf processes a replacement data repo, clones anything,
reinstalls system items, or rewrites metadata. Fresh-clone onboarding — a
committed `.capshelf/capshelf.json` with no `.capshelf/local.json` — is
unaffected.

## Remove an item without the data repo

`rm` resolved the data repo unconditionally and read the locked `sourceCommit`
to build the expected file set. Neither is needed to delete a copy directory,
so removal was impossible in exactly the cases that need it: a deleted clone,
or a rewritten upstream commit.

```bash
mv ~/code/agent-config ~/code/agent-config.bak   # clone is gone
capshelf rm skills/hello --yes
```

The data repo is now resolved lazily, and removal degrades when the source is
unreachable: every installed path is listed as a local-only path, so you still
see and consent to the full deletion list. Fragment and subagent removal still
need the data repo, because they rebuild shared outputs.

## `add` is a stable no-op for an installed item

Standalone `add` used to re-apply an installed item's content as a side effect.
It now converges instead, leaving bytes and lock untouched and printing the
command for what you probably meant:

```bash
capshelf add skills/hello
```

```text
= already installed project/data/skills/hello @ f6a183f88aa4
  Review installed changes: capshelf status skills/hello --diff
  Select newer upstream content: capshelf update skills/hello
  Restore the selected lock: capshelf apply skills/hello
  Discard installed changes: capshelf revert skills/hello
  Publish installed changes: capshelf promote skills/hello
  Keep installed divergence: capshelf keep-local skills/hello --reason <why>
```

Bundle installs are gated too. `add` used to branch to bundle expansion before
the destructive preflight and accept `--yes` there without ever reading it — so
the same fragment collateral was gated for a standalone `add` and ungated for
the bundle containing it, and bundles are what `capshelf init` suggests. Every
fragment member is now planned up front and gated once for the whole expansion:

```bash
capshelf add bundles/engineering --yes
```

## Config comments are gated only where losing them is loss

Comment loss counted as a destructive change for all three fragment targets.
For `.codex/config.toml` that is correct — `#` comments are standard TOML and
Codex reads them — so it remains a `config_comments` change that requires
consent, and dry-run and refusal output name the affected config path.

For the JSON targets it guarded a state the consuming tool rejects. Checked
against Claude Code 2.1.220, a `//` comment makes `.claude/settings.json`
silently not load, and makes `.mcp.json` fail to parse; capshelf reads either
only because of its own JSONC tolerance. Asking users to authorize keeping a
config the tool ignores was backwards, so a managed rewrite of those two files
now announces the repair instead of gating it.

## Smaller improvements

- One `apply` of a drifted copy item read the item's source tree fourteen
  times. Reconciliation now aliases an unchanged previous tree, destruction
  planning stopped discarding a duplicate read, and content at a commit is
  memoized. An 11-file item drops from 210 git calls to 46; a 51-file item goes
  from 770 calls and 1168 ms to 85 and 282 ms. The local filesystem stays
  uncached, because revalidation exists to notice that it changed.
- The `--json` error envelope is written straight to stderr. Bun colorizes
  `console.error` on a TTY, so an agent running capshelf through a pty received
  the envelope wrapped in ANSI escapes and could not parse it.
- The all-or-nothing preflight abort in `apply` and `update` is now scoped to
  fragment targets, which share output files. Independent copy and subagent
  items share nothing, so one unresolvable item is reported and every healthy
  item still converges; the command exits 1.
- `git status` porcelain is parsed with `-z` everywhere. Three parsers sliced
  the prefix off raw lines, and Git octal-quotes paths with non-ASCII, control,
  quote or backslash characters — so the marketplace dirty-projection guard
  failed open and overwrote uncommitted edits behind a clean `✓`, while the
  data-repo cleanliness check failed the other way.
- `update` can move a system item off superseded bundled content. A system
  entry's `sha` is provenance, not a retrieval handle; asserting a rebuilt file
  list against it made an ordinary capshelf upgrade abort the one command that
  could repair the state it refused to act on. `apply` still refuses an entry
  the binary cannot reproduce, and now says why and names the `update` that
  re-pins it.
- Copy-item publication is transactional. Apply and revert build a complete
  replacement tree in a temporary sibling directory, verify bytes and modes,
  then publish with renames, keeping the previous installation available as a
  backup. Fragment reconciliation checks every target before writing any of
  them and rolls earlier swaps back on failure.
- `marketplace sync --target codex` repairs clean committed projection drift
  without a prompt, and lists dirty affected paths for consent. Preview them
  with `capshelf marketplace sync --target codex --dry-run --json`.
- A data repo binding must canonicalize to the Git worktree root; a nested
  directory is no longer accepted. Copy-item names reject control characters,
  and copy-item trees accept regular files only — symlinks, Git links, and
  special objects are refused at both the working-tree and committed-object
  boundaries.
- `capshelf set-data <path>` is now the documented direct migration for a
  legacy `dataRepo` manifest field, instead of a three-step manual recipe.
- Configuration merge and serialization use own data properties throughout, so
  valid keys such as `__proto__` and `constructor` are neither lost nor
  mistaken for inherited values. TOML `inf`, `-inf`, and `nan` are rejected
  before hashing, since JSON canonicalization cannot represent them
  distinctly.
- The consent prompt is tested through the code that ships. The previous helper
  had no production callers and hardcoded its own prompt text, so the tests
  named as consent coverage never reached the real TTY prompt, the `y`/`N`
  parsing, or the cancel path.
- `docs/architecture.md` writes down the five-population object model for
  managed directories that every call site now classifies against, and
  `docs/cli.md` documents the consent boundary, its reasons, and the
  `keep-local` behavior table.
- `make check` runs `./scripts/check-release-docs-frozen.sh`: version-specific
  release documentation must never change once committed. Run it with
  `--audit` for a full-history inventory. What's New pages before 0.6 predate
  the policy and are grandfathered.

## Breaking changes

- **Non-interactive destructive operations refuse instead of writing.** `add`,
  `apply`, `update`, `rm`, `revert`, and `marketplace sync --target codex` exit
  3 under `--json` or on a non-TTY when the plan would destroy local state. Add
  `--yes` after reviewing, or handle exit 3.
- **`capshelf init` refuses an already-initialized machine** with exit 3. Use
  `data bind`, `data upstream`, or `update` for later lifecycle changes.
  Changing an existing project's install mode has no automatic migration.
- **Standalone `add` no longer re-applies an installed item.** Use `apply` to
  restore the lock, `revert` to discard edits, or `update` to select upstream.
- **`revert` no longer clears the `keep-local` marker** and no longer rewrites
  the lock. Clear the marker with `keep-local <item> --unset`.
- **`apply` and `update` no longer abort every write when a copy or subagent
  item fails preflight.** Healthy items converge and the command exits 1. A
  failing fragment target still aborts the whole run.
- **A data repo binding must be the Git worktree root.** A binding that points
  at a nested directory now fails; re-bind it with `capshelf data bind`.
- **Copy-item trees accept regular files only.** A data-repo item containing a
  symlink, Git link, or special object is refused rather than followed.
- No lockfile schema change: 0.7 reads and writes version 3, exactly as 0.6
  does.

## Upgrading

Upgrade capshelf, then re-pin the bundled system items to the new binary:

```bash
capshelf self-update        # Homebrew installs
# or re-run the install script / git pull && make install for source installs
capshelf status
capshelf update
```

There is no manifest, lock, or data-repo migration. Before the first write on a
project with local edits, review what a reconciliation would destroy:

```bash
capshelf apply --dry-run --json
capshelf status <item> --diff
```

Then audit any automation that calls capshelf non-interactively. A CI job or
agent script that ran `capshelf apply`, `capshelf update`, `capshelf rm`, or
`capshelf revert` against a project with drift will now exit 3 instead of
overwriting it. Decide per job whether the correct answer is `--yes` or a
failure that a human reviews — for a drift gate, exit 3 is the signal you
wanted.

Agents driving capshelf should treat `--yes` as a decision for the user: show
every affected path, use `capshelf status <item> --diff` for managed item drift
or the marketplace sync dry-run for projections, and get permission before
authorizing the loss. The bundled capshelf skill was updated to say so, which
is one reason to run `capshelf update` after upgrading.
