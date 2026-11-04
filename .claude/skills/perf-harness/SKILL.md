---
name: perf-harness
description: Measure capshelf latency and Git process counts, and prove that two capshelf binaries give the same results. Use for any change that moves a Git read, batches reads, or changes startup, and to compare a branch with a release.
---

# perf-harness

The tools are in `tools/perf/`. `docs/performance.md` explains each one and
how to read the numbers. Read it before you report a result.

## Compare two builds

1. Build each binary and copy it out of `dist/`. The next build overwrites
   `dist/capshelf`.
   ```sh
   bun run build && cp dist/capshelf /tmp/capshelf-new
   ```
   For an older ref, extract it with `git archive <ref> | tar -x -C <dir>`,
   link this tree's `node_modules` into `<dir>`, and run `bun run build` there.
   Do not check out another ref in this working tree.
2. Prove equal results on both fixture shapes. Each command must print
   `equal:` and exit 0:
   ```sh
   tools/perf/equiv.sh /tmp/capshelf-old /tmp/capshelf-new
   SPLIT=1 tools/perf/equiv.sh /tmp/capshelf-old /tmp/capshelf-new
   ```
3. Measure both shapes:
   ```sh
   tools/perf/bench.sh /tmp/capshelf-old /tmp/capshelf-new
   SPLIT=1 tools/perf/bench.sh /tmp/capshelf-old /tmp/capshelf-new
   ```
   Add `EXTRA=20000` once to show that no cost follows the size of the data
   repo.

## Find what to batch

```sh
SPLIT=1 tools/perf/trace.sh /tmp/capshelf-new status
```

A line whose count is near the item count is a Git call that runs once per
item.

## Rules

- Report the Git process count first and the wall time second. The count is
  exact. Wall time changes by 10 to 20 percent between runs.
- `equiv.sh` passing is necessary, not sufficient. A new batched read also
  needs a unit test that compares it with the read it replaces, on random
  inputs. Then break the batching on purpose and confirm that the test fails.
- The test suites remove their temporary files after a passing run. If
  `df -i /` still shows few free inodes, ask the user before you delete files
  that you did not create.
