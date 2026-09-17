# What's new in capshelf 0.13

## Summary

- `capshelf add <url>` installs a skill from any Git repository, not only from
  your shelf. It prints the facts and asks once.
- A remote skill is recorded in `.capshelf/remotes.lock.json`, which is
  gitignored. A teammate who clones the project gets neither the files nor the
  record.
- `capshelf status --check-upstream` fetches every tracked repository and
  reports which pins moved. Every other command stays offline.
- `capshelf share <item> --adopt` moves a remote skill into your shelf. The
  same flag adopts a skill that `skills.sh` manages.
- Status reports are faster. `capshelf status` in a project with 20 settings
  fragments took 289 ms instead of 1588 ms.
- The project lock stays at version 4. No project migrates.

Capshelf 0.12 managed what your shelf holds. Capshelf 0.13 adds a second
source, and keeps the two apart:

```text
data repo  --> capshelf.lock.json  + local.lock.json   committed / clone-local
repo URL   --> remotes.lock.json                       gitignored, this machine
```

A shelf item is yours to publish. A remote skill is not. `share --adopt` is
the one door between them.

The full command surface, with worked examples for every step, is in
[Remote skills](cli.md#remote-skills) in the command reference.

## Do I need to do anything?

| If you | Then |
|---|---|
| upgrade from 0.12 | No lock migration is necessary |
| track `skills/capshelf` | Run `capshelf update skills/capshelf` after the binary upgrade |
| want a skill from a public repository | Run `capshelf add <url>` |
| run the first `add <url>` in a project | Commit the `remotes.lock.json` line it appends to `.capshelf/.gitignore` |
| want your team to get a remote skill | Run `capshelf share skills/<name> --adopt` |
| script `capshelf add owner/repo` | Expect exit 3 now, where it was exit 1 |
| run capshelf in a sandbox with no network | Nothing changes, unless you pass a URL or `--check-upstream` |
| use `skills.sh` | `share --adopt` can take one of its skills |

## Install a skill from any repository

Capshelf never guesses which skill you meant. Use `--list` to see what a
repository holds, then name one with `--path`. The prompt prints the facts and
asks once:

```bash
capshelf add https://github.com/acme/pdf-skills --path skills/pdf
```

```text
  repo      https://github.com/acme/pdf-skills
  ref       main
  commit    cd91e33a2bddb67988805af8ec3bb045f88c4377
  path      skills/pdf
  install   .agents/skills/pdf  (local scope, gitignored)
  files     2 files, 143 B
              SKILL.md    103 B
              extract.py  40 B
  license   MIT  (LICENSE, at the repo root, outside the item, not copied)

  pdf: Extract text and tables from PDF files

  capshelf does not review this content. Your agent runs it with your permissions.
Install it? [y/N]
```

The answer covers that commit, not that row. A named `capshelf update` asks
again before it accepts new content. A bare `capshelf update` moves no remote
pin at all, because a routine sweep across a project must not become
interactive. `--yes` answers the question in both cases. In a non-TTY run,
including `--json`, it is the only thing that does.

`--as`, `--ref`, and `--path` shape the install. A browser URL carries the ref
and the subpath already.

## The record is local, and so is the skill

A remote skill installs into local scope and is recorded in
`.capshelf/remotes.lock.json`, schema version 1. The first `add <url>` appends
that file to the committed `.capshelf/.gitignore`, and adds the install paths
to `.git/info/exclude`. A teammate who clones the project therefore gets
nothing: no files, no record, no lock entry. The project lock is untouched.

`status` reports these rows in their own group:

```text
remote/  (skills pinned to repos outside your shelf)
  ✓   skills/pdf                              b265cade3978  up-to-date
      acme/pdf-skills main @ cd91e33, never checked
      check for newer upstreams: capshelf status --check-upstream
```

## Three surfaces reach the network, and no others

Capshelf 0.12 had three network operations. Capshelf 0.13 has five: the clone
`init` performs for an upstream URL, `capshelf data sync`, `self-update`,
`capshelf add <url>` including `--list`, and `capshelf status
--check-upstream`.

A URL on the command line is the only thing that makes `add` networked. No
project state can. `apply`, `update`, `rm`, `promote`, and a bare `status`
never open a connection, whatever the project holds. Only `--check-upstream`
sees that a repository moved, and it is the only way to re-create a clone
cache this machine has lost.

## Take ownership with `share --adopt`

A remote skill cannot be promoted. Its upstream is a repository nobody on your
team can publish to. `promote`, `move`, `keep-local`, `revert`, and a plain
`share` all refuse one and name the adopt.

`--adopt` vendors the installed bytes into your shelf, records the upstream,
the commit, and the subpath in the item's `.capshelf.yml`, and releases the
remote row last:

```bash
capshelf share skills/pdf --adopt -m "adopt the pdf skill"
```

After the adopt the item is an ordinary data item. The same flag adopts a
skill that `skills.sh` manages, releasing that row instead.

## Capshelf does not review a remote skill

There is no registry, no signing, and no scanning. The consent prompt prints
the facts and asks once. That is the whole control.

Three things make the prompt trustworthy. A URL that carries a credential is
refused rather than cloned, because `git clone` writes it into the cache
clone's `.git/config` and shows it in the process list. Credentials stay with
Git: capshelf inherits your credential helper, reads no token, calls no `gh`,
and stores nothing. Repository-controlled text in the prompt, which is the
file names and the item's description, has its control characters stripped. A
repository cannot repaint the question it is being asked about.

The trust model is in [`docs/security.md`](security.md).

## Faster status reports

A status report used to read the same Git objects many times. It now merges
each shared fragment output once, and it keeps each successful read for the
length of the report. The more settings fragments a project has, the more this
saves:

| Settings fragments | `capshelf status` before | after |
|---:|---:|---:|
| 1 | 116 ms | 101 ms |
| 5 | 250 ms | 144 ms |
| 10 | 584 ms | 201 ms |
| 20 | 1588 ms | 289 ms |

Each figure is the fastest of three runs on Linux aarch64, in a shared
container, on a project with two data skills and one system skill.
Shared-machine timing is indicative. These samples do not establish a latency
distribution.

`apply`, `update`, and `add` reuse reads the same way. The reuse is within one
command only, so a later command reads the repository again. A failed read is
never reused, and an object deleted between commands still causes a refusal.

## Unreadable fragment sources are refused

A committed fragment source must be a regular file. An absent optional source
is still valid. An empty directory, an unreadable blob, or a parse error is
now refused, and the error names the canonical path and the commit:

```text
✗ cannot read settings/team/settings.json at cd91e33a2bddb67988805af8ec3bb045f88c4377
```

`apply` and `update` refuse before they write any output or project metadata.
`status` reports the error instead of a healthy fragment row. Restore the Git
objects from a healthy data-repo clone, then retry. See
[Unreadable fragment sources](cli.md#unreadable-fragment-sources).

## Where the details are

| Question | Page |
|---|---|
| Every remote-skill command, flag, and output | [Remote skills](cli.md#remote-skills) |
| What capshelf trusts, and what it does not | [`docs/security.md`](security.md) |
| Why the record is a third document | [`docs/architecture.md`](architecture.md) |
| How remote skills are tested | [`docs/testing.md`](testing.md) |

## Smaller improvements

- `capshelf add owner/repo` now exits 3 and explains both readings. The kind
  list answers a mistyped kind, and the shorthand line answers a GitHub
  shorthand. It used to exit 1 with the parser's generic error.
- `--as`, `--ref`, `--path`, and `--list` are refused with exit 3 on a shelf
  item ref. A flag that a command would ignore is worse than one it refuses.
- `status <item> --diff` reads a remote skill's locked endpoint from its row.
  It read a capshelf lock before, which never holds a remote row, so the
  comparison had no starting point.
- `capshelf update skills/a mcp/a` no longer drops the second item. The shelf
  filter compared bare names, so one of two items with the same name was
  silently skipped and the command exited 0.
- `update --merge` on a remote skill reports `merged`, `mergeBase`, and
  `mergeResultDigest`. It computed all three and threw them away.
- A bare ref that matches both a shelf item and a remote skill is refused as
  ambiguous. The remote row used to win it outright.
- `rm` refuses a skill that both populations claim, and names the adopt that
  did not finish. The shelf path used to win silently and leave a remote row
  pointing at a deleted directory.
- `share` now resolves the data repo after its ref refusals. A refused share
  in a project with no data-repo binding reports the refusal and exits 3,
  where it reported "no data repo configured" and exited 6. It still exits 6
  when no earlier refusal applies.
- Every install and every pin move is recorded before the next one can refuse.
  A refusal on the second item no longer leaves the first item's bytes on disk
  with no owner.
- `capshelf status --check-upstream` writes no record in a project that has no
  remote skills. It used to append to the committed `.capshelf/.gitignore`
  from a command that only reports.

## Under test

`make smoke-remote` drives the whole remote-skill workflow from source against
a local bare repository. The end-to-end suite runs it against the compiled
binary, and adds two measurements the other layers cannot make. A
pseudo-terminal cell drives the consent prompt on a real terminal, on both the
accept and the decline path. A recording `git` on `PATH` proves that a bare
`capshelf update` opened no connection.

New integration tests pair Git read counts with output and failure assertions,
so a reuse boundary cannot move without a test noticing.

The release lane now resumes a deferred release. A tag pushed before the Test
run finishes waits, and the successful Test completion starts the release.

## Breaking changes

- `capshelf add <something>/<name>` exits 3 when the first segment is not an
  item kind. It exited 1 before. The supported kinds are `skills`,
  `pi-extensions`, `subagents`, `settings`, `mcp`, and `codex-config`.
- `capshelf share` exits 3 instead of 6 when a project has no data-repo
  binding and the share also hits an earlier refusal. The refusal is now
  reported instead of the missing binding.
- `capshelf add` refuses a repository URL that carries a credential. Remove it
  from the URL and let your Git credential helper supply it.
- `status --strict` exits 4 on a remote skill that has no clone cache on this
  machine, or that left its upstream repository. This is reachable only in a
  project that uses `capshelf add <url>`.

There is no lock-format change. Capshelf 0.12 and 0.13 use version 4 locks.
`.capshelf/remotes.lock.json` is a separate document at schema version 1, and
it exists only after the first `capshelf add <url>`.

## Upgrading

Upgrade the binary:

```bash
capshelf self-update
```

Source installs can use the usual build path:

```bash
git pull
make install
```

No lock migration is necessary. The bundled `capshelf` skill changed, so
update it once in each project that tracks it:

```bash
capshelf status skills/capshelf
capshelf update skills/capshelf
```

The first `capshelf add <url>` in a project appends `remotes.lock.json` to the
committed `.capshelf/.gitignore`. Review and commit that line, so the record
stays out of the project's history.

Nothing else changes for a project that does not use a repository URL. The
same commands reach the network as before.
