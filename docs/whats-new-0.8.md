# What's new in capshelf 0.8

> **Upgrading from 0.7?** This release needs one command per project, run in a
> set order across your machines and CI. It requires **Git 2.40.0 or newer**,
> and the lock upgrade is **one-way**. See [Upgrade](#upgrade) before you
> start.

Capshelf 0.8.0 changes what a lock entry *means*. An item's identity is now the
Git tree it was pinned to — a digest over each committed file's name, mode, and
blob id — instead of a hash of the data repo's working copy. That removes a
whole class of failure in which a project reported `up-to-date` forever while
`update`, `apply`, and `revert` all refused to run.

This is lock version 4. An older binary refuses a version-4 lock outright
rather than silently stripping every pin it touches, which is the compatibility
story rather than an accident: upgrade every writer before you commit a
migrated lock.

## Do I need to do anything?

| If you | Then |
|---|---|
| have projects tracking items with capshelf 0.7 or older | Yes — run `capshelf lock migrate` once per project, after every machine and CI job has the new binary |
| run capshelf in CI | Yes — upgrade the CI binary **first**, before anyone commits a migrated lock |
| are on Git older than 2.40.0 | Yes — upgrade Git first; nothing works without it |
| keep a data repo with `git-lfs` or `git-crypt` on managed paths | Yes — those items are now refused at pin time; see [Filtered content](#filtered-content-is-refused-in-every-clone-of-the-data-repo) |
| are installing capshelf for the first time | No — new projects are created at version 4 |

## Upgrade

**Prerequisite:** Git 2.40.0 or newer on your machine, because the filter
check reads attributes from the data repo's pinned commit with
`git check-attr --source`.

```text
1. upgrade capshelf on every machine and in CI
2. capshelf lock migrate --dry-run
3. resolve every blocker
4. capshelf lock migrate
5. commit the project lock as a lock-only change
```

Order matters at step 1. A binary older than 0.8 refuses a version-4 lock, so
committing a migrated lock before a teammate or a CI job upgrades will stop
them. Nothing silently downgrades a project either: no ordinary command
upgrades a lock, and every command that would *write* one refuses an
unmigrated project with migration guidance.

Until a project migrates, `status`, `ls`, `show`, and `apply` keep working.

## Breaking changes

- **Lock version 4 is one-way.** An older binary refuses a version-4 lock
  outright. Upgrade every writer before committing the migrated lock.
- **`capshelf lock migrate` is required once per project.** Every command that
  writes a lock — `add`, `update`, `promote`, `share`, `move`, `keep-local`,
  `rm`, `revert`, bundle installs, and `init` — refuses until you run it.
- **Git 2.40.0 is now the minimum.** Older Git exits 7.
- **The executable bit is part of identity.** Flipping it upstream is a real
  content change and shows as an update.
- **An item is refused if the data repo runs it through `git-lfs` or
  `git-crypt`.** Those tools store a stand-in rather than the file, so every
  project would receive the stand-in. The refusal is the same on every machine,
  including one where the tool works.
- **The project's Git no longer decides what managed content is.** An edit to
  the project's `.gitignore` cannot move an item's computed state, and a
  `--local` item — which capshelf excludes from project Git itself — is
  compared against real bytes.

## The failure this removes

A skill reported clean and could not be updated:

```console
$ capshelf status skills/csv-report
  ✓   data/skills/csv-report 7a855862ed97  up-to-date

$ capshelf status skills/csv-report --diff
(no local drift diff)

$ capshelf update skills/csv-report
✗ source skills/csv-report at ff11ed92… hashes to 50202f0b4775,
  but lock expects 7a855862ed97
```

The data repo was clean, the pinned commit existed, and every Git blob id
matched the index. One file differed in raw bytes only: the repository had
`core.autocrlf=input`, so Git normalized on the way in and kept CRLF in the
working copy. `git status` compares after normalization and reported clean.

Capshelf kept three copies of every item and derived identity from a different
input set for each: `add` copied the data repo's working tree, `apply` wrote
that repo's committed blobs, and `status` compared the install. Any two of
those disagreeing produced a lock no command could satisfy.

Version 4 takes identity from the commit and nothing else. Computing it reads
no file content at all, so working-tree state, Git configuration, checkout
filters, ignore rules, and the filesystem cannot reach it — and `add` now
materializes from the same blobs `apply` writes, so the two cannot disagree by
construction.

## What the migration does

```bash
capshelf lock migrate --dry-run
capshelf lock migrate
```

```text
Lock migration: → version 4
  converted                  49
  repaired legacy identity   1
  blocked                    0
Dry run; nothing written.
```

The migration selects no new content. For each entry it resolves the recorded
commit, reads the item's committed tree, and writes the pin — keeping
`appliedAt`, `needs`, `label`, and any keep-local marker exactly as they were.
It also audits the old hash against the commit it names, and reports a
disagreement as `repaired legacy identity`: that contradiction is the failure
above, repaired without changing which content the project holds.

The project lock and the local lock convert together, in one transaction. A
missing or invalid source blocks the whole run and writes nothing, with every
blocker listed in one pass. Resolve one by restoring the commit, by
`--repin <ref>` to the item's current committed source, or by
`--remove-item <ref>`.

## Repair an unprovable pin

`update` is the repair command. Its target is the current source commit, which
is a new, verified target, so it can replace both pin fields after consent.

`apply` and `revert` still refuse: their target *is* the locked commit, and
consent cannot create missing bytes or choose between two contradictory
identities.

```console
$ capshelf apply skills/csv-report
✗ ...
  the locked source cannot supply a verified target — repair the pin with: capshelf update skills/csv-report
```

One wedged item no longer stops a whole-project `update`. The failing item is
reported and every healthy item is still written.

## Drift now says what kind it is

```console
$ capshelf status skills/csv-report
project/
  ✎   data/skills/csv-report  4f9a02c7b1de  drifted (1 file: line-endings)
```

When a write would destroy something, the prompt says what the difference is:

```text
Update would destroy local state:
  project/data/skills/csv-report — .agents/skills/csv-report/template.csv — overwrite managed content
      line endings differ — a checkout may have rewritten this file
```

The classification explains; it never decides. Whether a file was rewritten by
a person or by a checkout is not decidable from bytes — a user who deliberately
converts a file to CRLF for a Windows tool produces exactly what
`core.autocrlf=true` produces — so the prompt appears either way.

`status --json` gains three independent axes (`pin`, `sourceState`,
`installation`) plus `installDifferences` and `filteredPaths`. The existing
`state` field still carries the derived headline, so current consumers are
unaffected.

## Filtered content is refused, in every clone of the data repo

`git-lfs` and `git-crypt` do not put your file in the repository. They put a
stand-in — a pointer file, or ciphertext — and restore the real bytes only
when the tool runs during checkout. Capshelf gives each project exactly what the
commit holds, so it would hand them the stand-in. It refuses instead, at the
point where it would record the pin:

```text
✗ not adding skills/deploy-helper
  skills/deploy-helper declares a git content filter, so its content is not portable

    config/credentials.yml    filter=git-crypt

  git stores a placeholder for this file, not the file. Every project would
  receive the placeholder.
```

The verdict is identical on every machine, including one where the tool is
installed and working, because the declaration is read from the data repo's
pinned commit rather than from your local setup. To share a secret, commit it
to the data repo already encrypted — with `sops` or `age`, and no filter
attribute.

## Smaller improvements

- **`core.autocrlf` and `text` attributes are no longer a problem.** A
  repository that normalizes line endings installs and updates normally, and
  every project receives what Git stores — the same bytes every `git clone`
  produces.
- **`status --diff` shows a line-ending difference.** It used to run in your
  own directory under your machine's global Git config, so on the machine that
  produced the original report it printed nothing for exactly the difference
  being investigated.
- **`promote` proves what it publishes.** The project snapshot is compared
  against the tree the commit produced, inside the transaction, so a
  `pre-commit` hook or a clean filter that rewrote content between the copy and
  the commit unwinds the promotion instead of publishing bytes the project
  never held.
- **`promote` runs your data repo's commit hooks on every path.** The commit
  mechanism used to depend on whether a Codex marketplace was configured: with
  one, the commit ran the repository's hooks; without one, it ran none. A
  secret scanner or a commit-message check therefore applied to the same
  command in one data repo and not in another. Every path now commits through
  a transaction, so your hooks always run.
