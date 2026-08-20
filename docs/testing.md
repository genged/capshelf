# Testing

Capshelf has four test layers. Each one owns a different boundary, and no
layer replaces another.

| Layer | Location | What it drives | What it proves |
|---|---|---|---|
| Unit | `tests/` | Pure functions and schemas | Rules, parsing, and edge cases |
| Integration | `tests/` | Modules and the CLI entry point in process | Wiring, fault injection, and coverage |
| Smoke | `scripts/smoke-*.sh` | `bun run src/cli.ts` | Command workflows from source |
| End-to-end | `e2e/` | One compiled executable | The packaged program a user installs |

The first three layers run from source. They are fast, and they can inject a
fault at any boundary. They cannot find a build, entry-point, or packaging
fault, because they never run the file the package installs. That is the gap
the E2E layer closes.

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

Each test prints one `evidence:` line with its labels —
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
`SIGTERM` to the whole process group, waits briefly, then sends `SIGKILL`, so a
grandchild cannot outlive the test. The deadline is not a performance
assertion.

One cell needs a terminal, because a consent prompt behaves differently on one.
That cell opens a pseudo-terminal through `e2e/support/pty-driver.py` and needs
`python3` on `PATH`; it fails with that message when it is absent. Its captured
output carries terminal echo and CR line endings, so it asserts substrings
rather than exact bytes.

## Continuous integration

The pull-request lane type-checks, runs the unit and smoke suites, builds
`dist/capshelf`, and then runs the E2E suite against that exact file.

The release lane first requires that the tagged commit already has a green
Test run from a `push` or `workflow_dispatch` event — work lands on `main`
directly, so a commit can be tagged before anyone knows whether it passed. A
pull-request run does not count: it carries the head SHA but checks out the
commit merged into its base, so it says nothing about the commit a tag points
at. Every job then checks out that resolved
commit rather than the tag, which can be moved after the check.

It builds every candidate archive once, uploads them, and validates each
archive on a matching native runner: verify the checksum, extract the
executable, check `capshelf --version`, and run the E2E suite against the
extracted file. Each validation records that it happened, and the publish job
requires one record per archive it is about to upload — so removing a platform
from the matrix stops the release instead of quietly shipping an unvalidated
binary. Publishing also re-checks that the tag still points at the validated
commit. Only that job can write releases.

A run on `main` is never cancelled by a later push: pushes group by commit,
so each one is independent. Grouping them by branch would not be enough,
because a *queued* run is cancelled when a newer run joins its group — rapid
pushes would keep the first and the last and discard everything between. Note
that one push carrying several commits is still one run, on the tip: the
commits under it are never tested, and a tag pointing at one of them is
refused by the release gate.

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
so an archive cannot exist without a native runner to prove it works.

The two release gates are shell scripts with their own tests
(`tests/release-gate-scripts.test.ts`), not logic embedded in YAML:
`require-green-test-run.sh` and `require-unmoved-tag.sh`.
