# Team workflow

How a team shares coding-agent capabilities through one data repo: syncing
teammates' changes, proposing changes through review, and gating project PRs
in CI. Command-level reference (flags, exit codes, JSON shapes) lives in
[`docs/cli.md`](cli.md).

## The team loop

Alice and Bob share `https://github.com/acme/agent-shared`. Both bootstrapped
their projects against local clones of it; both manifests declare
`dataRepoUpstream`.

Alice, in `~/code/billing`:

```bash
capshelf promote security-review -m "add SQLi checklist"
git -C ~/code/agent-shared push
```

Bob, in `~/code/checkout`:

```bash
capshelf sync-data
# fetched origin, fast-forwarded main 4f2a9c1 -> 8e7d3b2
capshelf status
# data/skills/security-review  update_available
capshelf update security-review
```

`sync-data` is the only capshelf command that touches the network, and only
when you run it. It fetches `origin` and fast-forwards the current branch only
when that is provably safe; diverged history, dirty worktrees, and detached
HEADs stop with copy-pasteable git guidance. `promote` never pushes — sharing
upstream is always an explicit `git push` in the data repo.

If Bob edits an item locally while someone else has already pushed a newer
version of it, `promote` refuses instead of silently clobbering:

```text
✗ skills/security-review changed in the data repo since this project last
  updated; promoting would overwrite the newer upstream version.
```

Bob inspects the upstream diff, then either preserves his current edit and
takes the upstream version first (`capshelf update security-review` replaces
the installed copy), or overwrites on purpose with `capshelf promote
security-review --stale-ok -m "..."`. For a local-scope skill, he copies the
edit outside the managed target first because local-scope files are excluded
from the project's Git repository, and uses `--local` on each recovery
command. If his edit turned out to be byte-identical to what upstream already
has, promote converges on its own: it re-pins the lock without a commit and
reports `already-upstream`.

## Proposing a change upstream (review required, or branch-protected main)

Capshelf never pushes and never creates branches. The data repo is an
ordinary git clone; branch in it with ordinary git, let `promote` commit on
your branch, then push and open a PR with `gh`.

Locate the bound data repo clone:

```bash
DATA=$(capshelf data-path)
# fallback for older capshelf binaries:
#   DATA=$(jq -r .dataRepo .capshelf/local.json)
```

The examples below assume the data repo's default branch is `main`;
substitute your repo's actual branch name throughout (`git -C "$DATA"
symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'`
prints it).

1. Start from current upstream and branch in the data repo:

   ```bash
   capshelf sync-data
   git -C "$DATA" switch -c propose/security-review-sqli origin/main
   ```

2. Edit the installed item in your project, then promote. The commit lands
   on your proposal branch; only this project's lock bumps:

   ```bash
   capshelf get-path security-review     # edit files under this path
   capshelf promote security-review -m "add SQLi checklist"
   ```

3. Push the branch and open the PR:

   ```bash
   git -C "$DATA" push -u origin propose/security-review-sqli
   gh pr create --repo acme/agent-shared \
     --head propose/security-review-sqli \
     --title "security-review: add SQLi checklist" \
     --body "Promoted from <project>; see capshelf lock for provenance."
   ```

4. After the PR merges, re-pin to the merged history:

   ```bash
   git -C "$DATA" switch main
   capshelf sync-data
   capshelf update security-review
   ```

   This step matters: until then your lock's `sourceCommit` points at the
   proposal-branch commit. With squash or rebase merges that commit is not
   on the default branch and becomes unreachable once the branch is
   deleted, so teammates' clones (and CI) cannot resolve it — `capshelf
   status` reports the item as `missing_source_commit` and `--strict`
   fails. Do not merge a project PR whose lock pins an unmerged proposal
   commit; the CI gate below fails it with exactly that state.

### Read-only consumers (no push access)

Fork variant:

```bash
gh repo fork acme/agent-shared --clone=false
git -C "$DATA" remote add fork git@github.com:bob/agent-shared.git
git -C "$DATA" switch -c propose/security-review-sqli origin/main
capshelf promote security-review -m "add SQLi checklist"
git -C "$DATA" push -u fork propose/security-review-sqli
gh pr create --repo acme/agent-shared --head bob:propose/security-review-sqli
```

Capshelf's upstream verification only checks the `origin` remote, so adding
a `fork` remote is safe, and `sync-data` keeps pulling from `origin`.

Patch variant (no GitHub account / air-gapped review):

```bash
capshelf promote security-review -m "add SQLi checklist"
git -C "$DATA" format-patch origin/main --stdout > security-review.patch
# send the patch; the maintainer applies it with `git am`
```

In both variants your local commit keeps working for this project
immediately; the lock pins it until you re-pin after the maintainer merges.

## CI drift gate

Teams paste this into a project repo to gate PRs on capshelf state:

```yaml
name: capshelf-drift

on:
  pull_request:

permissions:
  contents: read

jobs:
  drift-gate:
    runs-on: ubuntu-latest
    steps:
      - name: Check out project
        uses: actions/checkout@v4

      - name: Install capshelf
        run: |
          curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Clone the declared data repo
        run: |
          UPSTREAM=$(jq -r '.dataRepoUpstream // empty' .capshelf/capshelf.json)
          if [ -z "$UPSTREAM" ]; then
            echo "::error::no dataRepoUpstream declared in .capshelf/capshelf.json; the drift gate requires a declared upstream (run: capshelf set-upstream <url>)"
            exit 1
          fi
          git clone "$UPSTREAM" "$RUNNER_TEMP/capshelf-data"

      - name: Drift gate
        run: capshelf --data "$RUNNER_TEMP/capshelf-data" status --strict
```

Notes:

- `status --strict` exits 4 when any item is neither `ok` nor `kept-local`.
  As a PR gate this enforces three things at once:
  1. **Installed files match the lock** — no unreconciled drift.
  2. **Every locked `sourceCommit` is reachable in the declared upstream**,
     via the `missing_source_commit` state. A lock pinning an unpushed or
     squash-orphaned promote commit fails the gate — by design, this
     enforces "push/merge the data repo before merging the project PR".
     (Before this state existed, `status` did not check reachability and a
     squash-orphaned pin with matching content reported `ok`.)
  3. **The project is current with upstream** — `update_available` also
     trips `--strict`. Be aware this makes the gate a freshness ratchet:
     when anyone pushes to the data repo, open PRs go red until they run
     `capshelf update` (or `keep-local`). Teams that want drift-only gating
     without the freshness ratchet need a future `status` flag; capshelf
     deliberately does not ship one yet.
- Homebrew is preinstalled on GitHub-hosted ubuntu runners, so
  `brew install genged/tap/capshelf` is an alternative install step.
- Private data repos: clone with a token
  (`https://x-access-token:${{ secrets.CAPSHELF_DATA_TOKEN }}@github.com/acme/agent-shared`)
  or a deploy key. Upstream verification still passes because capshelf
  strips credentials from remote URLs before comparing against
  `dataRepoUpstream`.
- `CI` is set on runners, so capshelf's self-update startup prompt is
  already suppressed; no extra env needed.
- The gate never needs `sync-data`: the clone is fresh. CI is a pure
  read-only consumer.

## Fixing `missing_source_commit`

`capshelf status` reports `missing_source_commit` when an item's locked
`sourceCommit` is not present in the data repo clone being checked:

- it was squash- or rebase-merged upstream and the original commit is
  orphaned — re-pin with `capshelf sync-data && capshelf update <item>`
  (metadata-only when the merged content is identical);
- or it only exists in another clone (an unpushed promote) — push that
  clone first, then sync.
