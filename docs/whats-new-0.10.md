# What's new in capshelf 0.10

## TL;DR

- **Merge in your project, not in the data repo.** `capshelf update <item>
  --merge` writes the merged result to the installed copy. You review it, then
  you publish it with an ordinary `promote`.
- **`promote --merge` is deprecated.** It still works, and prints a notice.
- **`status --diff` prints two comparisons**: locked to installed, and locked
  to upstream. `--diff-view installed|upstream|all` selects one.
- **The diff shows the whole change.** It now shows a deleted file, an added
  empty file, and a changed file mode. 0.9 named these changes as drift, then
  printed nothing.
- **A data repo that moved no longer stops every command.** `status` reports
  what it can and exits 0. Commands that write give the recovery steps.
- **There is no lock migration.** Run `capshelf update skills/capshelf` one
  time in each project to take the new bundled skill.
- **For scripts:** one path can now give two `--json` diff entries. Use `path`
  and `view` together as the key.

The new route, in the order that you run it:

```bash
capshelf status <item> --diff                   # read both lines of work
capshelf update <item> --merge                  # merge into the installed copy
capshelf status <item> --diff-view installed    # review the merged result
capshelf promote <item> -m "..."                # publish it
```

## What changed

Capshelf 0.10 moves the merge out of `promote` and into `update`.

In 0.9, one command did two jobs. `promote <item> --merge` merged your edit
with the newer upstream version. It then committed the result to the data repo.
You read the merged text for the first time in that commit. A review comes too
late at that point.

In 0.10, `capshelf update <item> --merge` does the merge in your project. It
writes the merged result to the installed copy. It moves the lock to the
upstream commit. It changes nothing in the data repo. You read the result where
you can run it. Then you publish it with an ordinary `promote`.

```text
capshelf 0.9 — merge and publish in one command

   locked base ──┐
   your edit ────┼──> promote --merge ──> commit in the data repo
   upstream ─────┘                              │
                                                └─> you read the merged
                                                    text for the first time

capshelf 0.10 — merge, review, then publish

   locked base ──┐
   your edit ────┼──> update --merge ──> installed copy in your project
   upstream ─────┘                              │
                                                ├─> status --diff-view installed
                                                │   you read the merged text
                                                ▼
                                          promote ──> commit in the data repo
```

`promote --merge` still works in this release. It prints a deprecation notice.

`status --diff` shows the two lines of work that you must compare. It prints
two comparisons from the same locked base. The first goes from locked to
installed. The second goes from locked to committed upstream. Use
`--diff-view installed|upstream|all` to select one.

The diff also shows changes that 0.9 dropped: a deleted file, an added empty
file, and a changed file mode. The 0.9 row named these changes as drift, but
the 0.9 diff printed nothing.

The lock format does not change. Capshelf 0.9 and 0.10 read the same locks.
There is no migration.

## Do I need to do anything?

| If you | Then |
|---|---|
| use `promote <item> --merge` | Use `capshelf update <item> --merge`, review, then `capshelf promote <item> -m "…"`. The old flag warns, and still works |
| read `status --diff` by eye | `--diff` now prints two comparisons. `--diff-view installed` gives the 0.9 comparison, under new header text |
| script against `status --diff --json` | One path can now give two entries. Read the new [`view` key](#status---diff-shows-both-lines-of-work) |
| run `capshelf status --strict` in CI | A merge that you did not publish leaves the item drifted. `--strict` exits 4 until you publish it |
| have projects on capshelf 0.9 | Run `capshelf update skills/capshelf` one time in each project. It takes the new bundled skill |
| are on capshelf 0.7 or older | Run `capshelf lock migrate` first. See [What's new in 0.8](whats-new-0.8.md) |

## Merge in your project, publish after review

`promote` refuses a stale publication, as it did in 0.9. The message now names
the two-step route, in the order that you run it:

```console
$ capshelf promote skills/security-review -m "add PCI control names"
✗ skills/security-review changed in the data repo since this project last updated; promoting would overwrite the newer upstream version.

  locked:   68949e4f3f889332cb02fe4c099831afa0a2c7ceec40eed966a5ad203c5c8840  (sourceCommit 8501763)
  upstream: 8972583c0a61ac2531e2ef728524a0e87c4fa347df4fb6ccb41e5a06aca25914  (data repo HEAD)

  optional history context:
    git -C /home/agent/code/shelf log --oneline 8501763..HEAD -- skills/security-review

  inspect both lines of work:
    capshelf status skills/security-review --diff

  merge upstream into this installed copy:
    capshelf update skills/security-review --merge

  review the merged installed copy:
    capshelf status skills/security-review --diff-view installed

  publish after review:
    capshelf promote skills/security-review -m "..."
```

Read both lines of work first. Upstream changed the description. This project
changed the last paragraph:

```console
$ capshelf status skills/security-review --diff
project/
  ✎⚠  data/skills/security-review             68949e4f3f88  drifted + update available → 8972583c0a61ac2531e2ef728524a0e87c4fa347df4fb6ccb41e5a06aca25914

diff project/data/skills/security-review [locked -> installed]
--- SKILL.md (locked 8501763)
+++ SKILL.md (installed)
@@ -9,4 +9,5 @@ Check every changed handler for:
 - endpoints with no authorization check
 - user input written into a shell command
 
-Report each finding with the file and the line.
+Report each finding with the file and the line, and name the PCI
+control it breaks.

diff project/data/skills/security-review [locked -> upstream]
--- SKILL.md (locked 8501763)
+++ SKILL.md (upstream e7b66ea)
@@ -1,6 +1,6 @@
 ---
 name: security-review
-description: Review a diff for security defects.
+description: Review a diff for security defects. Run it before every merge.
 ---
 
 Check every changed handler for:
```

Then merge. The output names the three trees that the merge used. It also names
the two commands that come next:

```console
$ capshelf update skills/security-review --merge
✓ project/data/skills/security-review merged upstream into installed copy
  base: 8501763edc6db4852f6e87f3b9eb34f197318861
  upstream pin: e7b66eaf42b6915ee003d4e2e4e88ee10c0c17a4
  installed result: 57aa7d0c364d2ecf8f2786ae424d7d43a24540bfb5ca5fe21d39a1f8a89be214
  review: capshelf status skills/security-review --diff-view installed
  publish: capshelf promote skills/security-review -m "..."
```

The data repo did not move. The lock now points to the upstream commit. The
installed copy holds the merged result:

```text
after update --merge, before promote

   lock            ──> upstream commit     (update --merge moved it)
   installed copy  ──> merged result       (update --merge wrote it)
                            │
                            └─> the two differ, so status says "drifted"
                                and status --strict exits 4
```

That drift is the change that waits for publication. `--diff-view installed`
shows the patch that a later `promote` sends:

```console
$ capshelf status skills/security-review --diff-view installed
project/
  ✎   data/skills/security-review             8972583c0a61  drifted (1 file: content-edit)

diff project/data/skills/security-review [locked -> installed]
--- SKILL.md (locked e7b66ea)
+++ SKILL.md (installed)
@@ -9,4 +9,5 @@ Check every changed handler for:
 - endpoints with no authorization check
 - user input written into a shell command
 
-Report each finding with the file and the line.
+Report each finding with the file and the line, and name the PCI
+control it breaks.
```

To publish, use the ordinary command. It needs no merge flag:

```console
$ capshelf promote skills/security-review -m "name the PCI control in each finding"
✓ promoted data/skills/security-review @ 57aa7d0c364d2ecf8f2786ae424d7d43a24540bfb5ca5fe21d39a1f8a89be214
  source commit: f37b74c64ed153ab1f79f0f21714270b570945b6

committed to local data repo:
  /home/agent/code/shelf

to share upstream:
  cd /home/agent/code/shelf
  git push

$ capshelf status skills/security-review
project/
  ✓   data/skills/security-review             57aa7d0c364d  up-to-date
```

Between the merge and the promote, the project is in a usual drifted state.
Each command that reads drift operates as before. `revert` restores the pinned
bytes and discards the merge. `keep-local` records the difference as
intentional. `status --strict` exits 4. If your CI runs `--strict`, publish
before you push.

## What the merge accepts, and what it refuses

`update --merge` is a standard Git three-way content merge. The base is the
locked content. The local side is the installed copy. The upstream side is the
item at data-repo HEAD.

A conflict writes nothing. It changes no installed file, no lock, and no data
repo. It lists the paths that conflict:

```console
$ capshelf update skills/security-review --merge
✗ automatic merge conflicts in skills/security-review; nothing changed.

  conflicting paths:
    SKILL.md
```

A clean merge is not proof of a correct merge. Git shows that the two edits
touched different lines. Git does not show that the result reads as one
document. Review the result before you publish it.

The command has narrow limits:

- **Skills and Pi extensions only**, in project scope and local scope. This is
  wider than `promote --merge`, which refuses a local-scope Pi extension.
  Capshelf names the item that it refuses:

  ```console
  $ capshelf update settings/permissions --merge
  ✗ update --merge supports only skills and pi-extensions; settings/permissions is not supported
  ```

- **One explicit item.** `capshelf update --merge` with no item exits 3. Two
  items also exit 3. A merge is a decision for one item.
- **No `--yes`.** You cannot use `--merge` and `--yes` together. `--yes` gives
  permission to destroy the installed edit. `--merge` keeps that edit.
- **A clean data repo.** Every command that reads a commit needs this.
- **A base that capshelf can prove.** The locked source commit must exist. It
  must be an ancestor of HEAD. It must contain the item directory. It must give
  the locked content again. If one of these fails, capshelf stops the merge.

`--dry-run` reports the same three trees, and writes nothing. `--json` adds
`merged`, `mergeBase`, `mergedUpstreamCommit`, and `mergeResultSha` to the item
entry. Note the difference between two fields. `sha` and `plannedSha` hold the
upstream pin. `mergeResultSha` holds what your project now has.

## `status --diff` shows both lines of work

`--diff` prints locked to installed first, then locked to upstream. It prints
each comparison for every row that has one. The two comparisons start from the
same locked base, so you can read them together.

```text
                    ┌───────────────┐
                    │  locked base  │  the commit your lock points to
                    └───────┬───────┘
          --diff-view       │       --diff-view
           installed        │        upstream
              ┌─────────────┴─────────────┐
              ▼                           ▼
     ┌──────────────────┐        ┌──────────────────┐
     │  installed copy  │        │  data repo HEAD  │
     └──────────────────┘        └──────────────────┘
     what promote sends          what update brings in
```

`--diff-view` selects one comparison. It also turns on `--diff`:

```bash
capshelf status <item> --diff-view installed   # what a promote would send
capshelf status <item> --diff-view upstream    # what an update would bring in
capshelf status <item> --diff-view all         # both; the default
```

Capshelf refuses a value that it does not know:

```console
$ capshelf status --diff-view sideways
✗ invalid --diff-view sideways; expected installed, upstream, or all
```

The headers changed. They now name the comparison, and the commit for each
side. 0.9 printed this:

```diff
diff data/skills/security-review
--- SKILL.md (locked data/skills/security-review)
+++ SKILL.md (current)
```

0.10 prints the item with its scope, the direction, and the commit for each
side:

```diff
diff project/data/skills/security-review [locked -> installed]
--- SKILL.md (locked 8501763)
+++ SKILL.md (installed)
```

In `--json`, each entry keeps `item`, `path`, and `text`. Each entry adds
`view`, `from`, and `to`:

```json
{
  "item": "project/data/skills/security-review",
  "view": "upstream",
  "from": { "role": "locked",   "sha": "57aa7d0c364d…", "sourceCommit": "f37b74c64ed1…" },
  "path": "/home/agent/code/my-app/.agents/skills/security-review",
  "to":   { "role": "upstream", "sha": "f06402396c00…", "sourceCommit": "64d682ade46b…" },
  "text": "--- SKILL.md (locked f37b74c)\n+++ SKILL.md (upstream 64d682a)\n…"
}
```

**One path can now give two entries.** A program that used `path` as the key
kept one entry and lost the other. Use `path` and `view` together as the key.

If capshelf cannot build a comparison, the entry has `text: null` and an
`unavailableReason`. Capshelf keeps the entry, so a program can tell "no
difference" from "cannot read".

## The diff shows the whole change, not only the text

An item's identity includes file existence and the executable bit. `status`
counts a deleted file and a `chmod -x` as drift, and names both in the row.

The 0.9 diff compared text only. An absent file and an empty file both gave an
empty string, and the file mode never reached the comparison. The row named two
changed files, and the diff showed none:

```console
$ capshelf status skills/security-review --diff          # capshelf 0.9
project/
  ✎   data/skills/security-review             7fee93bd88ef  drifted (2 files: missing, mode)

(no local drift diff)
```

Each side of the comparison now holds existence, content, and mode. The change
prints in the form that `git` uses for it:

```console
$ capshelf status skills/security-review --diff-view installed
project/
  ✎   data/skills/security-review             7fee93bd88ef  drifted (2 files: missing, mode)

diff project/data/skills/security-review [locked -> installed]
--- findings.md (locked be28d7e)
+++ findings.md (installed)
deleted file mode 100644

--- scan.sh (locked be28d7e)
+++ scan.sh (installed)
old mode 100755
new mode 100644
```

The upstream comparison shows the same detail. An empty file added upstream is
a real change to take, and 0.9 had no view that could show it:

```console
$ capshelf status skills/security-review --diff-view upstream
project/
  ⚠   data/skills/security-review             7fee93bd88ef  update available → 33ca541a011ad083442157b10cfd04de0b158315b91075b0537b254fa2615120

diff project/data/skills/security-review [locked -> upstream]
--- TODO.md (locked be28d7e)
+++ TODO.md (upstream 94493fa)
new file mode 100644
```

This is important where the diff is the review step. `apply`, `rm`, `revert`,
and `update` print `status <item> --diff-view installed` as the command to run
before you agree to a destructive change. You cannot review a change that the
diff does not show.

## Reconciliation checks the paths that it writes

Capshelf keeps the local-only files that are inside a managed directory. It has
done this since 0.7. A kept path and a managed path can collide. They can have
the same name, or one can be inside the other. 0.10 looks for a collision
before it writes, on both routes:

- **`update --merge` plans the reconciliation before it starts to write.** It
  checks the destination paths and the kept paths against the merge result. A
  collision stops the command. It no longer occurs in the middle of a write.
- **The kept-path check uses the folding of the destination.** It compared
  names as exact strings. It therefore missed `Notes.md` against `NOTES.md` on
  a case-folding filesystem. It also missed a decomposed name against a
  composed name where the filesystem normalizes names. It now probes the
  destination, and uses the folding of that destination. `add` already used
  this test on pinned paths.
- **The frozen-tree reconciliation lists every path that it can write or
  remove, before it changes the copied tree.** The transaction that restores
  the original tree on failure never starts with a plan that it cannot
  complete.
- **Capshelf refuses a `skills.sh`-owned skill two times.** `update --merge`
  checks external ownership before it plans, and again before it saves.
  External tools stay external state, as on every other command.

## A missing data repo no longer stops every command

A project can record a data-repo binding, and the clone can then move or go
away. Capshelf 0.9 asked the missing directory for its `origin` remote. The
answer was "no origin". Every command exited 4 with a repair that you could not
run, because the directory in the message did not exist:

```console
$ capshelf status                                        # capshelf 0.9
✗ data repo at /home/agent/code/shelf has no `origin` remote configured.
  .capshelf/capshelf.json declares dataRepoUpstream: https://example.invalid/shelf
  add the remote and retry:
    git -C /home/agent/code/shelf remote add origin https://example.invalid/shelf
```

Capshelf now checks that the path is a Git repository, before it asks that
repository a question. A recorded binding that names no repository is the same
state as no binding. Commands that only read give the report that they can.
Commands that write give the recovery steps.

`status` reports the project and exits 0:

```console
$ capshelf status
project/
  ✓   system/skills/capshelf                  238255ea75f5  up-to-date
  !   data/skills/security-review             f06402396c00  no longer in data repo
      requirements freshness unavailable
```

Every command that writes exits 6 with the clone, bind, and retry steps:

```console
$ capshelf update
✗ no data repo configured for this project.
upstream (per .capshelf/capshelf.json): https://example.invalid/shelf

  1. clone it somewhere you control:
       git clone https://example.invalid/shelf <path>
  2. point capshelf at it:
       capshelf set-data <path>
  3. retry:
       capshelf apply
```

Capshelf passes a `--data` path through without change. The error then names
the path that you typed, and the repair for that path:

```console
$ capshelf update --data /home/agent/code/nope
✗ not a git repository: /home/agent/code/nope
  initialize with: git -C /home/agent/code/nope init && git -C /home/agent/code/nope add -A && git -C /home/agent/code/nope commit -m "baseline"
```

## `apply` writes all fragment outputs together

Fragment kinds share output files. Several `settings` items merge into
`.claude/settings.json`. `mcp` items merge into `.mcp.json` and
`.codex/config.toml`.

`update`, `rm`, and `revert` always wrote those outputs as one unit. A partial
write leaves a runtime that disagrees with the lock. `apply` did not do this.
It wrote one target at a time, so a target that failed left the earlier targets
on disk.

`apply` now builds every fragment plan first. It then writes the plans in one
operation, which brings the rollback that already existed. It also sorts its
targets, so the write order agrees with the preflight order. If a fragment
target fails, the report adds one line:

```
  no fragment output changed; fragment outputs are reconciled together
```

## Smaller improvements

- **The stale-promote refusal names every choice, in order.** 0.9 offered
  `update` and `--stale-ok`. Each of those discards one side of the work, and
  0.9 never named the merge. One rule now decides both the message and the
  gates that enforce it. The message cannot offer a command that the gate then
  refuses.
- **`promote --merge` prints a deprecation notice.** It still merges and
  publishes in one step. It prints the replacement route on stderr. A `--json`
  call prints no notice, so machine output does not change.
- **Each "review this first" message names one comparison.** `apply`, `rm`,
  `revert`, and `update` named `status <item> --diff`, which now prints the
  upstream comparison as well. They now name
  `status <item> --diff-view installed`. That is the local state that the
  command replaces.
- **The bundled `capshelf` skill describes the two-step route.** It described
  `promote --merge` as the way to reconcile a stale promote. It also sent
  agents to `--diff` where `--diff-view installed` is the correct view.
- **The `status --diff` example in the README agrees with the CLI again.** It
  showed the 0.9 header format.

## Under test

These changes are for contributors. They are the reason that capshelf found
three defects in this release before a user did.

- **An end-to-end suite that drives the compiled binary.** Ten scenarios run
  `dist/capshelf` as a child process. The scenarios are fresh clone,
  divergence, recovery, lock migration, fragment ownership, runtime targets,
  bundles, extensions and catalogs, coexistence, and proposal review.

  - Each test builds its own world: a root, `HOME`, XDG directories, an empty
    global Git config, and repositories.
  - The child environment comes from an allowlist. `CAPSHELF_HOME`, `GIT_DIR`,
    credential helpers, and proxies cannot get in.
  - There is no fallback to `bun run src/cli.ts`. A run therefore cannot mix
    packaged components and source components.
  - `bun run e2e` builds the binary and runs the suite. `bun run e2e:run` runs
    against `CAPSHELF_E2E_BIN` and never builds, so a release lane can point it
    at an extracted archive.
  - `docs/testing.md` describes all four layers, and the rules that the harness
    follows.

- **The release gate needs a green run for the commit itself.** Work goes to
  `main` directly, so a commit can get a tag before anyone knows that it
  passed. A `pull_request` run does not count. It carries the head SHA, but it
  checks out that commit merged into its base. A second check refuses to
  publish when the tag no longer points at the validated commit.
- **One declared Bun version.** `package.json#packageManager` is the only place
  that holds a version. Workflows read it with the `bun-version-file` input of
  setup-bun. That input fails open: an unreadable file gives a warning, and the
  action falls back to the latest Bun. The two jobs that build a binary
  therefore assert the version that they got. `scripts/check-bun-pin.sh` and
  `scripts/check-e2e-bin.ts` are gone, and `make check` lost a target. Both
  invariants are now enforced where they are used.
- **One list of release platforms.** `scripts/release-platforms.json` feeds
  both the packaging script and the validation matrix, so the two cannot
  disagree.

## Breaking changes

- **`status --diff` prints two comparisons, and new headers.** A script that
  reads the human output for `diff data/<kind>/<name>` or
  `+++ <file> (current)` finds no match. `--diff-view installed` gives the 0.9
  comparison, but not the 0.9 header text.
- **A `--json` diff entry is no longer unique for each path.** `--diff` gives
  one entry for each path in each view. Use `path` and `view` together as the
  key.
- **`promote --merge` is deprecated.** It works in 0.10, and prints a notice.
  Use `update --merge`, then a plain `promote`.
- **`make check` no longer runs `check-bun-pin` or `check-e2e-bin`.** Both
  scripts are gone. If a contributor script calls one of those targets, remove
  the call.

## Upgrading

There is no lock migration. The lock format is version 4 in 0.9 and in 0.10.
The two versions interoperate, and you can upgrade in any order.

```bash
capshelf self-update          # Homebrew installs
```

The bundled `capshelf` skill changed. After you install the new binary, each
project that tracks the skill reports an available update:

```bash
capshelf status skills/capshelf   # update available → … (cli upgraded)
capshelf update skills/capshelf
```

Then look at each project that has a merge in progress. A `promote --merge`
that you ran under 0.9 is published, and needs nothing. A merge that you start
under 0.10 stays in the installed copy until you publish it. `capshelf status`
reports it as drift, and `capshelf status --strict` exits 4 until you publish
it.
