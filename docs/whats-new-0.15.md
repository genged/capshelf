# What's new in capshelf 0.15

## Summary

- `capshelf share` now shares a skill or a plugin to project scope when
  project Git already tracks its install path. In 0.14, that share refused
  with exit 3.
- The share picker uses the same default, so it no longer offers a share
  that fails.
- An explicit `--to local` still refuses a tracked skill.

Capshelf 0.15 is a small release. It has no lock change, no manifest change,
and no data repo change.

## Do I need to do anything?

| If you | Then |
|---|---|
| upgrade from 0.14 | Upgrade the binary. No project needs a migration |
| track `skills/capshelf` | Run `capshelf update skills/capshelf` once in each project |
| share a skill that you committed to the project | Run `capshelf share skills/<name>` with no `--to` |
| want a tracked skill in local scope | Remove it from project Git first, then run `share --to local` |

## Share a skill that project Git already tracks

Without `--to`, `share` puts a skill or a plugin in local scope. Local scope
hides the install path with `.git/info/exclude`. That file cannot hide a file
that Git already tracks. Thus in 0.14, `share` refused every skill that you
had committed to the project.

When project Git tracks the install path, your teammates already have the
files. Capshelf 0.15 then picks project scope, and the output names the
tracked path:

```bash
git add .agents/skills/release-check
git commit -m "add release-check skill"
capshelf share skills/release-check
```

```text
✓ shared project/data/skills/release-check @ a3ca6d376851e521c29dea44f6368750acb994a913c3202d570421ac3e363cc2
  source commit: 43af0cdb7d2c530aae735a992b9b706a2617fd23
  project scope: git already tracks .agents/skills/release-check

committed to local data repo:
  /home/mg/code/capshelf-data
```

The skill goes into the `skills` array of `.capshelf/capshelf.json`. Capshelf
adds no line to `.git/info/exclude`. In `share --json`, the `scope` field is
`project`.

A skill that project Git does not track still goes to local scope. Pi
extensions, subagents, and fragments still go to project scope.

An explicit `--to local` does not change. It refuses a tracked skill with
exit 3:

```bash
capshelf share skills/release-check --to local
```

```text
✗ local install path is already tracked by git: .agents/skills/release-check
  .git/info/exclude cannot protect tracked files; remove it from git or use project scope
```

Remote adopts and skills.sh adopts stay in local scope. Their install paths
are excluded from Git, so project Git cannot track them.

## The share picker

`capshelf share` with no item opens the picker. In 0.14, the picker offered
a tracked skill for local scope, and that share failed. The picker now uses
the same default as the named command. The equivalent command that it
prints has no `--to` flag.

## Where the details are

| Question | Page |
|---|---|
| The default scope of `share` | [Skills and copy items](cli.md#skills-and-copy-items) |
| The defaults that the picker uses | [share and promote](cli.md#share-and-promote) |

## Smaller improvements

- `capshelf share --help` now states the new default for `--to`.
- The bundled `capshelf` skill now states the new default for
  `share skills/<name>`.

## Breaking changes

None. A share that 0.15 completes in project scope refused with exit 3 in
0.14. A tracked skill that you share has one more line of text output. That
line starts with `project scope:`.

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

The bundled `capshelf` skill changed. Update it once in each project that
tracks it:

```bash
capshelf status skills/capshelf
capshelf update skills/capshelf
```

There are no manifest, lock, or data repo migrations. The lock stays at
version 5.
