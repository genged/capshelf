# Security

This page describes capshelf's security position for teams and organizations
deciding whether to adopt shared agent capabilities. The short version:
capshelf deliberately has almost no security machinery of its own. It pins
content, refuses to act on the network implicitly, and makes drift loud —
and it delegates every trust decision to the git hosting that already owns
your data repo. Whether that is enough depends on how you run that repo.

## Threat model: shared items are code-adjacent

The items capshelf distributes look like configuration, but they should be
reviewed like code. Adding an item from a data repo means trusting its
authors and everyone with write access to that repo, with this blast radius
per kind:

| kind | what a malicious or careless item can do |
|---|---|
| `settings` | merged into `.claude/settings.json`, which can configure hooks — shell commands the agent harness executes on events. A settings fragment can run arbitrary commands on your machine. |
| `mcp` | merged into `.mcp.json` / `.codex/config.toml`, which launch MCP servers. Those servers run as you, with your credentials, filesystem, and network access. A fragment can point at a hostile server binary or pass it hostile arguments. |
| `codex-config` | merged into `.codex/config.toml`; same class of risk as MCP fragments for anything Codex executes from config. |
| `skills` | prose, not executables — but prose that steers an agent which *does* have execution tools. A skill can instruct an agent to exfiltrate data, weaken reviews, or run commands. Subtler than a hook, not safer. |

There is no meaningful "config-only, therefore safe" tier. Treat
`capshelf add` the way you treat adding a dependency, and treat write access
to the data repo the way you treat commit access to a shared library.

What capshelf itself does on your machine is narrow: it reads the data repo
clone you bound, writes managed files inside the current project, and commits
to the data repo only on explicit `share`/`promote`. It does not execute item
content. Execution happens later, in Claude/Codex, when the agent loads what
capshelf materialized — which is exactly why review has to happen before
content reaches the data repo's default branch.

## The control plane is your git host

This is a deliberate architecture, not a gap: capshelf delegates
authentication, authorization, and review entirely to git hosting.

- **Who can publish** is the data repo's write permissions.
- **What gets published** is branch protection plus PR review on the data
  repo. A reviewed default branch is the trust boundary; capshelf adds no
  second one.
- **Who can consume** is the data repo's read permissions (private repos are
  the access-control story; capshelf reads through your authenticated local
  clone and never manages credentials).

Capshelf's own contribution is reproducibility and tamper-evidence around
that boundary:

- **Every item is pinned.** The committed lock records a content hash (`sha`)
  and the data-repo commit that produced it (`sourceCommit`). `apply` and
  `revert` restore content via `git show <sourceCommit>:<path>`, so what a
  project runs is auditable back to a specific reviewed commit, and a moved
  data-repo HEAD changes nothing until a project opts in with `update`.
- **No implicit network I/O.** Capshelf never pushes — `promote` commits to
  your local clone and prints the `git push` you may choose to run. It never
  fetches behind your back either: the only network operations are the
  one-time clone in `init --data <remote-url>`, the explicit `sync-data`
  command, and the Homebrew `self-update` command. `sync-data` is the single
  verb that talks to the data repo's remote — it fetches and fast-forwards
  only when provably safe, and only when you run it. Nothing in
  `status`/`apply`/`add`/`update`/`promote` can be made to pull unreviewed
  content onto your machine.
- **Drift is loud.** `status` reports any divergence between locked content
  and on-disk files, and it checks that every locked `sourceCommit` is
  reachable in the bound data repo, reporting `missing_source_commit` when
  one is not. `status --strict` fails on both, with exit code 4. Run in CI,
  this catches both local tampering with managed files in a consuming project
  and locks that pin commits not reachable in the declared upstream — an
  unpushed or squash-orphaned promote commit surfaces as
  `missing_source_commit` even when the content hash happens to match.
- **Wrong-repo binding fails hard.** When the committed manifest declares
  `dataRepoUpstream`, capshelf refuses to use a clone whose `origin` does not
  normalize to that URL (exit 4). A contributor cannot be silently pointed at
  a look-alike repo with the same item names.

## What capshelf does not do

Explicitly out of scope, with the reasoning:

- **Content signing.** Provenance is the data repo's git history and your
  host's commit/PR audit trail. A capshelf-layer signature scheme would
  duplicate that with weaker key management than your git host already has.
- **Sandboxing or execution control.** Capshelf never executes item content;
  Claude/Codex do. Sandboxing agent execution is the agent harness's job
  (and its permission system's), not a file-syncing CLI's.
- **Vetting, capability scanning, or malware analysis.** Capshelf cannot
  judge whether a hook command or an MCP server is benign. Pretending to
  (a scanner, an allowlist) would convert human review into false confidence.
  Review on the data repo is the real control.
- **Registries or central distribution.** There is no capshelf server to
  compromise and no namespace to typosquat. A data repo is a git repo you
  chose, with the access controls you configured.

The common thread: at this layer, delegation beats reinvention. Git hosting
already has identity, permissions, protected branches, required review, and
audit logs that your organization operates and trusts. Capshelf's job is to
make consumption of that reviewed content pinned, explicit, and verifiable —
not to build a parallel, weaker trust system.

## Guidance for teams

Concretely, for a team or org data repo:

1. **Protect the default branch** of the data repo and require PR review for
   all changes. The default branch is what teammates' `update` pulls in; it
   should never be writable without review.
2. **Treat `settings/*`, `mcp/*`, and `codex/config/*` changes as
   privileged.** They configure things that execute. Consider a stricter
   reviewer set (e.g. CODEOWNERS) for those paths than for `skills/*`.
3. **Gate project PRs in CI** with `capshelf status --strict` against a
   fresh clone of the declared upstream. This blocks unreconciled drift,
   locks pinning unpushed or orphaned data-repo commits (reported as
   `missing_source_commit`), and stale pins; any of these fails the gate
   with exit code 4.
4. **Review `update` like a dependency bump.** Before bumping pins, inspect
   what changed: `capshelf status` shows update availability,
   `capshelf status <item> --diff` shows content differences, and
   `git log <sourceCommit>..HEAD -- <kind>/<name>` in the data repo shows the
   reviewed commits you are about to adopt. Lock changes land in the project
   PR, where they get a second review.
5. **Mind the Codex trust boundary.** Codex only loads a project's
   `.codex/config.toml` in trusted projects; capshelf surfaces a warning in
   `status` when Codex appears likely to ignore the file. The check runs
   only when the `codex` binary is on `PATH`, and `status --strict`
   deliberately does not fail on it — it is advisory, not a drift state.
   Marking a project trusted in Codex is the moment shared codex/MCP
   fragments become live — do it consciously.
6. **Keep `promote` flowing through review.** `promote` only commits
   locally; teams that require review should branch in the data repo clone
   before promoting, then push the branch and open a normal PR. Capshelf
   never pushes for you, so the review path cannot be bypassed by the tool.

## Reporting vulnerabilities in capshelf

If you find a security issue in capshelf itself (the CLI, its file handling,
its git invocations), please report it privately rather than opening a
public issue. Use GitHub's private vulnerability reporting on
[github.com/genged/capshelf](https://github.com/genged/capshelf)
(Security tab → "Report a vulnerability"). That is the only reporting
channel.

Please include the capshelf version (`capshelf --version`), your platform,
and a minimal reproduction. Fixes ship through the normal release channel
(Homebrew tap), and `capshelf self-update` picks them up. The repo-root
[`SECURITY.md`](../SECURITY.md) carries the GitHub-standard policy summary.

Issues in shared item *content* (a malicious skill or fragment in some data
repo) are not capshelf vulnerabilities — report those to the owners of that
data repo, through the same review channel that should have caught them.
