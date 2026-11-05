# Performance tools

The tools in `tools/perf/` measure capshelf latency and prove that a faster
binary gives the same results. Use them for every change that moves a Git read
or a process start.

Most of the time of a capshelf command is Git processes. One process costs
about 1 to 2 ms on a Linux VM, and more on macOS. So the first number to read
is the count of Git processes, and the second is the wall time.

## Before you start

- Build the binaries to compare. `bun run build` writes `dist/capshelf`. Copy
  it to a path outside `dist/` before you build the second binary.
- To build an older version, extract it with `git archive <ref>` into a
  temporary directory, link this tree's `node_modules` into it, and run
  `bun run build` there.
- The tools need `git`, `bash`, `bc`, and `sha1sum` on `PATH`.

## The fixture

Each tool builds its own fixture from scratch with `tools/perf/lib.sh`. The
fixture is a data repo and a project with every item installed and committed.
Commit dates are fixed, so two builds of one shape give the same commit ids.
That is why the tools do not keep fixtures on disk: a rebuild takes a few
seconds and gives the same repository.

Set the shape with these variables:

| Variable | Default | Meaning |
|---|---|---|
| `SKILLS` | 30 | Number of skills, each with three files |
| `SUBAGENTS` | 10 | Number of subagents, each with a Claude and a Codex file |
| `SETTINGS` | 3 | Number of settings fragments |
| `SPLIT` | 0 | `1` gives each item its own data-repo commit |
| `EXTRA` | 0 | Number of non-item files in the data repo |
| `PERF_WORK` | temporary | Keep the fixture in this directory |

Measure at least two shapes. With `SPLIT=0`, all items share one commit, which
is the state after one `update`. With `SPLIT=1`, each pin is a commit of its
own, which is the state of a data repo that grows over time. A read that is
shared per commit costs much less in the first shape than in the second.
`EXTRA=20000` shows a cost that follows the size of the repository and not the
number of items.

## Measure: `bench.sh`

```sh
tools/perf/bench.sh /path/to/old-capshelf /path/to/new-capshelf
SPLIT=1 tools/perf/bench.sh /path/to/old-capshelf /path/to/new-capshelf
```

The tool runs one command sequence for each binary. First it runs `ls`,
`status`, `status --diff`, `apply`, and `update` on a clean project. Then it
makes one data-repo commit that changes every item, and runs them again. Each cell shows wall seconds and
the number of Git processes. `CAPSHELF_GIT_MEASURE=1` makes capshelf print the
count when it exits.

Run the tool two or three times. Wall time on a shared VM changes by 10 to 20
percent from run to run. The process count does not change.

## Prove equal results: `equiv.sh`

```sh
tools/perf/equiv.sh /path/to/old-capshelf /path/to/new-capshelf
SPLIT=1 tools/perf/equiv.sh /path/to/old-capshelf /path/to/new-capshelf
```

The tool builds a small fixture with these hard cases:

- a unicode item name and a unicode file name
- an executable file
- an item that declares a Git filter driver
- an upstream change to a sidecar only
- a dirty data repo
- a drifted install and a deleted installed file

Both binaries then run the same sequence of `status`, `status --diff`, `ls`,
`apply`, and `update` commands.

The tool compares stdout, stderr, the exit code, the lock, the executable bits,
and the hash of every installed file. It masks timestamps. It exits 0 when all
of them are equal. When one differs, it prints the difference and exits 1.

An equal result on this fixture is necessary, not sufficient. A change to a
Git read also needs a unit test that compares the new read with the old read
on random inputs. `tests/git-batch-reads.test.ts` and
`tests/git-history-walk.test.ts` are examples.

## Find the cost: `trace.sh`

```sh
SPLIT=1 tools/perf/trace.sh /path/to/capshelf status
```

The tool puts a `git` script first on `PATH` and runs one command. Then it
prints each distinct Git command with its count. It masks commit ids and item
numbers. So a line with a count near the number of items is a call that runs
once per item. Those lines are where batching helps.

## History walk: `walk-bench.ts`

```sh
bun tools/perf/walk-bench.ts 20000 10
```

`status` and `update` select the source commit of every item with one
`git log` walk. This tool builds two long histories with `git fast-import`
and compares the walk with one `git log -1` per item. In the first history,
every item changes in the newest commits, so the walk stops early. In the
second, items change only in the first commit. The walk must fill every answer
in both, and it must not be slower than the separate calls.

## Disk use

The performance tools remove their own work directory unless `PERF_WORK` is
set. The test suites remove their temporary files after a passing run, as
[`docs/testing.md`](testing.md) describes. A failing smoke script keeps its
files for inspection, so remove them after you read them.
