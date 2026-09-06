# LOC dashboard

A helper that shows how production lines and test lines developed over the
history of a Git repository. It is a local tool for maintainers. It is not
part of the capshelf release: nothing under `src/` imports it, `bun run
build` does not bundle it, and the binary does not serve it.

## Run

```sh
bun run loc-dashboard
bun run loc-dashboard -- --repo ../other-repo --branch main --port 4719
```

The server binds `127.0.0.1` on a free port and prints one URL. Open that
URL. The first read counts every blob once and takes a few seconds on this
repository. Later reads and the Refresh button reuse the counts and only
read new commits.

## What it shows

Every widget reads the same slice of history, chosen by the filter row at
the top.

- **Range.** Presets for 7, 30, 90, and 365 days, all history, and a custom
  date pair. The default is the last 30 days. The selection lives in the URL
  hash (`#/30d`, `#/all`, `#/2026-08-01..2026-08-31`), so a reload keeps it.
  A drag across the chart zooms to that span as a custom range.
- **Tiles.** Prod lines, test lines, the test-to-prod ratio, and the commit
  count at the end of the range, each with its change since the start of
  the range.
- **Lines over time.** One axis, two step lines. A count changes at a commit
  and holds until the next, so the line steps. The value before the range
  carries in from the left and the last value holds to the right edge. Hover
  or move with the arrow keys to read one commit, with both counts and the
  change each made. The legend hides a series without repainting the other.
- **Measures.** Test coverage from `bun test --coverage` and the anti-slop
  Oxlint results, for the checkout as it is now. See below.
- **Where the lines live.** Each series at the last commit in the range,
  grouped by the first two path segments, with the change since the range
  start. Both columns share one scale.
- **What counts.** The rules in force.
- **Commits in range.** The chart's table twin: every commit in the range,
  newest first, with both counts and both deltas. Hovering a row moves the
  chart's crosshair to it.

## What counts

A line counts when it is not blank. A file counts when it matches a rule in
`rules.ts` at that commit. The default rules are:

| Series | Files |
| --- | --- |
| prod | `src/**/*.{ts,tsx,css}` |
| test | `tests/**/*.{ts,tsx,sh,py}`, `e2e/**/*.{ts,tsx,sh,py}`, `scripts/smoke-*.sh` |

Paths that match no rule do not count: documents, configuration, generated
files, and assets. Commits follow the first parent of the branch, so a merge
counts once, at the merge. Dates are committer dates.

## Measures

Coverage and lint cannot be read from history the way line counts can: each
needs a full test run or lint run at that commit. So a run measures the
working tree now, and every run is recorded, so a history builds up as you
use the dashboard.

- A run starts when the server starts, unless the store already holds a run
  for the current clean HEAD or you pass `--no-measure`. The Run again
  button starts another. One run goes at a time.
- Coverage runs `bun test --coverage --coverage-reporter=lcov --parallel=4`
  into a temporary directory and sums the lcov report. Bun reports only the
  files a test loaded. The threshold comes from `coverageThreshold` in
  `bunfig.toml`, and the badge says whether the run meets it. Failing tests
  are named. The least covered files are listed with a meter that turns
  orange below the line threshold.
- Oxlint runs `bun --bun oxlint --format json` and counts findings by
  severity, rule, and file. Exit code 1 means findings; higher exit codes
  are reported as a failure.
- Runs are stored in `$XDG_CACHE_HOME/loc-dashboard/<hash>.json`, or
  `~/.cache/loc-dashboard/`, one file per repository path, newest 200 runs.
  The card names the commit and says when tracked files had uncommitted
  changes at run time. The small history shows the runs inside the selected
  range once there are two.

## Layout

| File | Role |
| --- | --- |
| `serve.ts` | The localhost server. Bundles the client into memory at start, serves `/`, `/app.js`, `/app.css`, `/logo.png`, `/api/history`, `/api/breakdown?sha=`, and `/api/measures`. `POST /api/measures/run` starts a run; everything else is GET. |
| `measures.ts` | Runs coverage and Oxlint, parses lcov and the Oxlint JSON, and keeps the run store. |
| `collect.ts` | Reads git: `log --first-parent`, `ls-tree`, and one `cat-file --batch` pass per batch of commits. Caches line counts by blob id and totals by commit id. |
| `count.ts` | The streaming non-blank line counter. |
| `rules.ts` | The prod and test rules and the directory grouping. |
| `shared/types.ts` | The API types. |
| `shared/series.ts` | Range parsing, slicing with carry-forward, summaries, ticks, and number formats. Pure. |
| `client/` | The Preact client. `Dashboard.tsx` holds the state. `LocChart.tsx` is the SVG chart. `Measures.tsx` is the coverage and lint cards. |

The style is the capshelf web UI's: its tokens and chrome are copied from
`src/ui/client/styles.css`, so the two stay independent. The series colors,
green `#1a7f45` for prod and blue `#2a78d6` for test, were validated with the
dataviz palette checker against the white surface. Orange stays reserved for
attention, as in the product UI.

## Check

```sh
bun test ./tools/loc-dashboard
bun run typecheck
bunx biome check tools/loc-dashboard
```

The unit tests cover the rules, the line counter, the series math, the lcov
and Oxlint parsers, the threshold reader, and the run store. The collector
test builds a temporary repository with three commits and checks the counts,
the cache reuse across a new commit, and the breakdown. Bun's test root is
`tests/`, so the path argument is required.
