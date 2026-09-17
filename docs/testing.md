# Testing

Capshelf has four test layers. Each one owns a different boundary, and no
layer replaces another.

| Layer | Location | What it drives | What it proves |
|---|---|---|---|
| Unit | `tests/` | Pure functions and schemas | Rules, parsing, and edge cases |
| Integration | `tests/` | Modules and the CLI entry point in process | Wiring, fault injection, and coverage |
| Smoke | `scripts/smoke-*.sh` | `bun run src/cli.ts` | Command workflows from source, including `scripts/smoke-remote.sh` for remote skills |
| End-to-end | `e2e/` | One compiled executable | The packaged program a user installs |

Every layer needs the web UI bundle, because the CLI entry point imports it.
`bun install` builds it, and `bun run test` and `bun run build` build it
again before they run. `scripts/smoke-ui.sh` and `e2e/scenarios/ui.test.ts`
cover `capshelf ui` with a headless fetch, which proves the served bytes and
the API, not the rendering.

The first three layers run from source. They are fast, and they can inject a
fault at any boundary. They cannot find a build, entry-point, or packaging
fault, because they never run the file the package installs. That is the gap
the E2E layer closes.

Every smoke script sources `scripts/smoke-lib.sh`, which detaches the suite
from terminal input (`exec < /dev/null`). The library passes no flags of its
own: a script that needs consent passes `--yes` at its own destructive call,
and a script written on the assumption that the library supplies it refuses
with exit 3 at the first one. Smoke therefore proves non-interactive behavior
only. Terminal behavior belongs to the E2E pseudo-terminal cells.

## Read reuse regression coverage

These integration tests pair read counts with output and failure assertions:

- Status reports merge each shared fragment output once and retain
  each item's target set (`tests/status-read-amplification.test.ts:144`, `:290`).
  Repeated reports observe output deletion and changed requirements
  (`tests/status-read-amplification.test.ts:144`, `:175`).
  Injected HEAD and object-directory failures check retry behavior
  (`tests/status-read-amplification.test.ts:175`, `:223`).
- Diff collections reuse output plans and compare complete results with
  independent direct calls (`tests/status-read-amplification.test.ts:322`,
  `:426`, `:495`). Cases vary lock content, scope, project, repository, and
  dirty shared-output sources. Direct and collected calls also detect later
  output edits, malformed JSON, and missing commits
  (`tests/status-diff.test.ts:590`).
- Writer tests count successful immutable Git requests for `apply`, `update`,
  and standalone, bundle, and interactive fragment adds
  (`tests/writer-read-memo.test.ts:87`, `:422`). Repeated commands check fresh
  reads, unchanged bytes, and `already-current` results
  (`tests/writer-read-memo.test.ts:87`). Removing a blob between invocations
  must cause refusal, including calls that reuse an exported install context
  (`tests/writer-read-memo.test.ts:157`, `:495`).
- Writer fault injection checks edits during confirmation, changed HEAD,
  damaged copy publication, and rollback after a second fragment write fails
  (`tests/writer-read-memo.test.ts:198`, `:239`, `:300`, `:369`).

Use these tests to check reuse boundaries. For manual investigation, use the
[Git read diagnostics](cli.md#git-read-measurements).

## The end-to-end layer

Every E2E test starts the compiled executable named by `CAPSHELF_E2E_BIN` as a
child process. The harness validates that path before it creates a test world.
There is no fallback: not `bun run src/cli.ts`, not `process.execPath` plus the
entry file, not a `capshelf` on `PATH`, and not an in-process `main()` call. A
run therefore cannot mix packaged and source components.

```bash
bun run e2e          # build dist/capshelf, then run the suite against it
bun run e2e:run      # run the suite against $CAPSHELF_E2E_BIN; never builds
make e2e             # same as bun run e2e
make check           # every layer, with e2e last
```

`bun run e2e:run` never builds, because a release lane points
`CAPSHELF_E2E_BIN` at an extracted release archive. A job that could rebuild
its candidate would no longer be testing the file it publishes.

### What a test may do

Each test owns one temporary world: its own root, `HOME`, XDG directories,
empty global Git config, repositories, and logs. The child environment is built
from an allowlist rather than copied from `process.env`, so `CAPSHELF_HOME`,
`CODEX_HOME`, `GIT_DIR`, credential helpers, and proxy settings cannot leak in
undeclared.

Four layers stay separate, and every test says which ones it used:

| Layer | Allowed work | What it proves |
|---|---|---|
| Fixture control | Create homes, repositories, remotes, and tool cells | Preconditions only |
| Actor action | Run the compiled CLI, ordinary Git, or a real service | A user or CI workflow |
| Independent observation | Read bytes, modes, links, Git state, and process results | The public result |
| Compatibility action | Use a hosted service or an installed runtime | Provider behavior |

A helper may run an actor's command. It must not write that command's expected
result. A fixture may construct a damaged state for a recovery test, and the
test then says that the state was constructed: it proves recovery, not that an
interruption produces the state.

`e2e/` holds four directories. `e2e/support/` is the harness library: the
world, the command runner, the PTY driver, the network canary, the Git
recorder, and the evidence report. `e2e/harness/` self-tests it, so a harness
fault names the harness instead of surfacing as a scenario that did not prompt.
`e2e/environments/` holds terminal and user-level cells. `e2e/scenarios/`
holds product workflows, including `remote-skill.test.ts`, which drives the
remote-skill workflow against a local bare repository standing in for a host.
It states what stays unproved: GitHub itself, its authentication, and its rate
limits.

Each scenario and environment test prints one `evidence:` line with its labels —
`reproduced-user-workflow`, `modeled-external-step`,
`constructed-recovery-state`, or `real-provider-compatibility` — and names what
stays unproved. Set `CAPSHELF_E2E_REPORT=<path>` to collect those records as
JSON lines.

### Assertions

A test asserts the public contract and independent state: documented exit
codes, semantic `--json` fields, bytes, file types, modes, symlink targets, Git
state, and a final `status --strict` result. It does not rebuild capshelf's
algorithm, and it does not use capshelf's own status or hash output as the only
oracle.

**A test asserts what the documentation promises, not what the binary
currently does.** When the two disagree, the test fails and stays failing until
the product matches. Weakening an assertion to accommodate a known defect —
asserting "it refused" instead of the documented exit code and message —
produces a suite that is green against behavior nobody agreed to, which is the
one outcome worse than having no test. A defect that is not worth fixing is
worth changing the documentation for; either way the assertion tracks the
contract, never the current output.

Two rules apply to every mutating workflow:

- **Safe failure.** A command that refuses must leave an enumerated snapshot of
  owned state byte-identical. The scenario selects which snapshots apply —
  project files, project Git, data repo, bare remote, required absences — and
  there is no catch-all selection.
- **Null second run.** After a successful reconcile, the same command runs
  again. It must exit 0, report `already-current`, write nothing, and leave
  strict status clean.

### Network

The suite uses local bare Git repositories for every fetch, push, and
divergence workflow. It carries no credentials and sets `GIT_TERMINAL_PROMPT=0`,
which stops an interactive prompt but does not stop network access.

A canary measures the real condition and names the lane. When an external
connection fails, the lane is `offline`. When it succeeds, the lane is
`no-credential local-remote` — a weaker, accurate name. Set
`CAPSHELF_E2E_REQUIRE_OFFLINE=1` on a runner that denies non-local egress to
make the denial mandatory instead of measured.

A local bare repository models Git transport and ref advertisement. It proves
nothing about GitHub review, branch protection, or credential helpers. Those
claims need a separate compatibility test against a real provider.

A claim that one command stayed offline needs a different measurement.
`world.git.recordInvocations()` puts a recording `git` on `PATH` for that one
command. The shim logs the argv and then execs the real Git. Exit 0 proves
nothing here, because capshelf reports a failed fetch instead of throwing. A
command that fetched and swallowed the error exits like one that never tried.
`e2e/scenarios/remote-skill.test.ts` measures a bare `update` this way. The run
must record Git, and none of it may be `fetch`, `clone`, or `ls-remote`. A run
that recorded no Git at all measured nothing, so the test fails on that too.

### Debugging a failure

A failed assertion prints the command, working directory, outcome (exit code,
signal, timeout, or spawn failure), stdout, stderr, and a short directory tree.
Known secret values are redacted from every diagnostic field.

By default each world is removed when the test ends. `KEEP_E2E_TMP=1` keeps it
and prints its path:

```bash
KEEP_E2E_TMP=1 CAPSHELF_E2E_BIN="$PWD/dist/capshelf" bun test ./e2e/scenarios/fresh-clone.test.ts
```

Every command has a generous safety deadline. At the deadline the runner sends
`SIGTERM` to the whole process group and waits briefly. It then sends
`SIGKILL`, so a grandchild cannot outlive the test. The deadline is not a
performance assertion.

Some cells need a terminal, because a consent prompt and the pickers behave
differently on one. The picker cells cover the `init`, `add`, `share`, and
`promote` entry points. The consent cells cover two gates. One is the
destructive-change planner. The other is the question a remote skill asks
before it installs content nobody on the team reviewed. Those cells open a
pseudo-terminal through `e2e/support/pty-driver.py`. They need `python3` on
`PATH`, and they fail with that message when it is absent. The captured output
carries terminal echo and CR line endings, so they assert substrings, not exact
bytes.

The driver gives that terminal a window size and turns off carriage-return
translation. A bare pseudo-terminal has neither. Its defaults are not what a
real terminal gives a program.

Without a window size, the terminal reports zero columns. A full-screen prompt
then lays out inside zero columns. It draws one character per line and never
finishes.

With `ICRNL` on, a carriage return arrives as a newline. Node reports those two
as different keys. `Enter` therefore stops being `Enter` for a prompt that
reads raw keys. With the driver's settings, `\r` in an answer means `Enter` for
either kind of prompt. A `\n` still ends a line for a canonical one.

A line-oriented prompt noticed neither default. Both stayed invisible until an
interactive list was tested here.

Each world sets `TERM=dumb`, which keeps line-oriented output deterministic. A
full-screen prompt cannot run on a terminal that declares no capabilities.
capshelf refuses one. A cell that drives such a prompt therefore asks for a
real `TERM` through the command's `env`. One cell keeps the default on purpose,
to hold the refusal.

An answer for a canonical prompt goes into the terminal before the program can
configure it. An answer for a raw-mode prompt cannot. It has no newline, so an
early write leaves it in the terminal's unfinished-line buffer. On macOS the
switch to raw mode discards that buffer. The prompt then draws an empty query
and waits forever. A cell that drives a raw-mode prompt therefore sets
`answerAfterRawMode`, and the driver holds the answer until the program turns
canonical mode off. Either way the keys go in as one burst, so these cells
prove that the keys reach the program and what it does with them. They do not
prove behavior under per-keystroke timing.

An asynchronous pane needs staged input. The PTY helper can wait for one output
substring before it sends the next key group. The promote picker cell uses this
mode to wait for the diff. It then closes the pane and promotes the row.

## Continuous integration

The pull-request lane type-checks, runs the unit and smoke suites, builds
`dist/capshelf`, and then runs the E2E suite against that exact file. A
separate lint job in the same workflow runs Biome and the Oxlint anti-slop
check.

A release needs a version tag and a successful Test run for the same commit.
Only same-repository `push` and `workflow_dispatch` runs count.
Pull-request results cannot authorize publication.
See `scripts/require-green-test-run.sh:27`.

The Release workflow responds to tag pushes, manual requests, and successful
Test completion events. Either event order works:

```text
Tag first  -> defer -> Test completes -> release
Test first -> no tag -> tag arrives   -> release
```

The completion event supplies the tested SHA. Discovery selects version tags
that point to that SHA, including tags from later API pages.
Failed Test runs and runs from forks skip discovery.
See `.github/workflows/release.yml:7` and
`scripts/resolve-release-request.sh:7`.

The previous gate failed when Test was still running. The gate now defers
without keeping a runner active. Successful Test completion starts a new
Release run. Short coordination jobs still consume runner time.
A missing Test run also defers. Push that commit to `main` or start Test
manually on a ref that points to it.
See `scripts/require-green-test-run.sh:40` and
`scripts/prepare-release.sh:26`.

Release jobs use a concurrency group for each resolved tag. The group covers
the reusable release workflow, including publication.
After entering the group, a request checks whether its tag is already published.
Published releases skip validation and packaging. Draft releases can resume.
See `.github/workflows/release.yml:50`,
`.github/workflows/release-lane.yml:17`, and `scripts/prepare-release.sh:18`.

An eligible release repeats the source tests and builds each candidate archive.
It validates those archives on matching native runners before publication.
The checks include checksums, the executable version, and the E2E suite.
Build and validation jobs check out the pinned SHA. Publication checks the tag
again and uses the validated archives.
See `.github/workflows/release-lane.yml:39`, `:47`, `:101`, and `:156`.

The caller grants write permission to the reusable release job. The called
workflow limits its default permission to read. Its publish job can write releases.
See `.github/workflows/release.yml:53` and
`.github/workflows/release-lane.yml:13`, `:160`.

GitHub requires the completion-triggered workflow on the default branch.
Merge the workflow change into `main` before relying on automatic resumption.
See [GitHub workflow_run documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

A run on `main` is never cancelled by a later push: pushes group by commit,
so each one is independent. Grouping them by branch would not be enough,
because a *queued* run is cancelled when a newer run joins its group — rapid
pushes would keep the first and the last and discard everything between. Note
that one push carrying several commits is still one run, on the tip: the
commits under it receive no Test run from that push. A release for one of
those commits defers until it has a successful eligible run
(`scripts/require-green-test-run.sh:40`).

One lane defines "does this commit work": `.github/workflows/test-lane.yml`.
The pull-request lane calls it, the release calls it before packaging, and a
scheduled canary calls it with the newest Bun — so those three cannot drift
apart.

One Bun version is declared in `package.json#packageManager`, and
`.github/actions/bun-toolchain` installs it and then asserts which version
arrived: setup-bun warns and falls back to the newest Bun when it cannot read
the declared version, and a warning does not fail a job.

One file declares the release platforms: `scripts/release-platforms.json`. The
packaging script builds from it and the validation matrix is derived from it,
so an archive cannot exist without a native runner to prove it works. The
packaging script also counts what it built against what the file declares, so
a runner cannot exist without its archive either. The v0.10.0 release failed
in that direction: a shell read loop dropped the last platform in the file,
and the gap surfaced only as a validation job that could not find its
candidate. `tests/release-packaging-script.test.ts` runs the real script with
only `bun build --compile` stubbed, so the platform list stays under test.

The two release gates are shell scripts with their own tests
(`tests/release-gate-scripts.test.ts`), not logic embedded in YAML:
`require-green-test-run.sh` and `require-unmoved-tag.sh`.

Release coordination tests execute the shell scripts with GitHub API fixtures.
They cover both event orders, duplicate requests, pagination, and API failures.
These tests do not exercise GitHub event delivery or its concurrency scheduler.
See `tests/release-coordination.test.ts:1`.
