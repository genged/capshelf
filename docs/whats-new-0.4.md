# What's new in capshelf 0.4

Capshelf 0.4 is about working with other people — and other agents. You can
now hand a teammate a single URL to get them productive, your coding agent
can discover what's on the shelf instead of guessing from names, a team can
flow changes through the data repo safely in both directions, settings and
MCP servers you've already configured can be shared without hand-crafting
fragment files, and curated bundles set up a whole project in one command.

Everything below is additive: existing projects, lockfiles, and data repos
keep working unchanged. The one removal is the long-deprecated
`promote --create` (see Breaking changes).

## Start a project from a URL

Previously, using a shared data repo meant cloning it yourself and binding
the local path. Now `init` accepts a remote URL directly:

```bash
cd ~/code/my-app
capshelf init --data https://github.com/acme/agent-config
capshelf add security-review
```

Capshelf clones the repo once to a predictable location
(`~/.local/share/capshelf/data/github.com/acme/agent-config`, or wherever
`--data-dir <path>` says), binds the project to that clone, and records the
URL as the project's `dataRepoUpstream` so teammates' clones are verified
against the same source. HTTPS and SSH forms both work; the clone is a
normal git working tree you can inspect, branch, and push from.

Two helpers round this out:

- `capshelf data-path` prints the bound clone's location (`--json` includes
  the normalized upstream) — useful before running git commands against it.
- After every `promote` commit, capshelf prints where the commit landed and,
  when the data repo has an `origin`, the `git push` command to share it.

`set-data` still takes a local path only; pointing it at a URL now fails
with guidance instead of doing something surprising.

## Install without Homebrew

For Linux machines, devcontainers, and CI, there's now an install script
that downloads the latest release for your platform, verifies its SHA-256
checksum, and installs to `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/genged/capshelf/main/scripts/install.sh | sh
```

Homebrew (`brew install genged/tap/capshelf`) remains the primary path.

## A shelf your agent can actually browse

Items can now carry catalog metadata, and three commands grew up around it.

Describe any item with an optional `.capshelf.yml` next to its content in
the data repo:

```yaml
# skills/security-review/.capshelf.yml
description: Deep multi-pass security audit of changed files.
tags: [security, review]
requires:
  - settings/permissions-base
conflicts-with:
  - skills/quick-review
```

Skills also contribute the `name`/`description` from their SKILL.md
frontmatter automatically — if your skills already have good frontmatter,
`ls` and `search` improve with zero work.

Why does the sidecar have a `description` at all when skill frontmatter
already carries one? Three reasons. Settings, MCP, and codex-config items
have no frontmatter — the sidecar is their only metadata source, and one
schema covers all four kinds. The two descriptions also have different
costs: frontmatter ships to Claude and is hashed, so editing it is real
content drift (every consuming project sees "update available"), while a
sidecar edit is free — no drift anywhere. And they speak to different
readers: frontmatter is the invocation trigger Claude reads at runtime
("Use when the user asks to…"), which is often poor catalog copy, while
the sidecar describes the item to whoever is browsing the shelf. For
skills the sidecar `description` is optional and usually unnecessary —
most skill sidecars will carry only `tags`/`requires`/`conflicts-with` —
but when both exist, the sidecar wins.

**`ls`** shows descriptions and `#tags`, and filters with `--tag` (repeat
it to narrow):

```text
$ capshelf ls --tag security
data/  (from ~/code/agent-config)
  skills/security-review    a1b2c3d4e5f6  Deep multi-pass security audit of chan…  #security #review
  settings/permissions-base deadbeef0123  Baseline permission allowlist.  #security
```

**`search`** is new — it matches names, tags, descriptions, and item
content, ranked so curated signal beats incidental word hits:

```bash
capshelf search "sql injection"
capshelf search security --kind skills --json
```

Zero matches exit 0: an empty answer is an answer, not an error.

**`show`** prints the full metadata, including whether each relation is
already installed, so you (or your agent) can evaluate before installing.

**`add`** enforces the relations: a missing `requires` item produces a
warning with the exact `capshelf add <ref>` commands to fix it; an
installed `conflicts-with` item refuses the install (exit 3) and prints the
two legitimate ways out. There is deliberately no `--force`.

Metadata is catalog data, not content: it is never copied into projects,
never hashed, and never moves a pin. Edit a tag or description in the data
repo, commit it, and no consuming project sees drift or needs `update`.
Malformed metadata warns and degrades — a typo can't make an item
undiscoverable or uninstallable.

The bundled `capshelf` skill was rewritten around this loop, so an agent
working in your project now surveys (`status`, `ls --here`), discovers
(`search`, `ls --tag`), evaluates (`show`), installs (`add`), and verifies
(`status --strict`) instead of pattern-matching on names.

## Set up a whole project with bundles

A bundle is a named set of items, defined as a plain file in the data repo:

```yaml
# bundles/go-backend.yml
description: Everything a Go backend service needs.
includes:
  skills:   [security-review, go-test-writer]
  settings: [permissions-base, permissions-go]
  mcp:      [github, postgres-local]
```

```bash
capshelf show bundles/go-backend    # preview members + install state
capshelf add bundles/go-backend     # install them all
```

Expansion is all-or-nothing: a read-only preflight checks every member
(missing items, conflicts — including between bundle members — dirty paths,
fragment merge collisions) and refuses with a per-member report before
anything is written. Already-installed members are skipped without touching
their pins, so re-running a bundle after it grows installs just the new
members. After expansion the members are ordinary independent items — the
bundle is a macro, not a versioning unit, so one project updating an item
never drags other bundle members along.

## Share config straight from your project

Sharing a settings or MCP fragment used to require a separate source file
(`--from ./settings.json`) — awkward, because nobody has fragment files
lying around. The values you want to share already live in
`.claude/settings.json`, `.mcp.json`, or `.codex/config.toml`. Now `share`
extracts them in place, and for the most common case — an MCP server you
configured by hand — it needs no flags at all:

```bash
# share an MCP server you configured by hand
capshelf share mcp/github

# share the permission allowlist you built up in this project
capshelf share settings/permissions --pick permissions.allow
```

For mcp items every flag now has the right default: the scope is `project`
(fragments never supported local scope, so the old `local` default could
only error), the value to extract defaults to the server matching the item
name, and the target is wherever that server actually lives — capshelf
scans both `.mcp.json` and `.codex/config.toml` and adopts every output
that contains it, as one logical item in a single data-repo commit. If the
server isn't found anywhere, the error lists the unmanaged server names
that are available to share. Explicit flags remain for the other cases:
`--pick <server>` when the item name differs from the server name,
`--target claude|codex` to restrict the share to one output.

`--pick <path>` is repeatable, and only the *unmanaged remainder* of the
output is eligible: the current file minus every locked fragment's
contribution. That's what keeps extraction deterministic — unmanaged values
have exactly one owner, the project. Picking a value another fragment
already manages refuses and names the owning fragment, so the right move
(edit that fragment and `promote`) is always in the error message. The
output file itself doesn't change; the picked values simply become managed
by the new fragment, and other projects pick them up with a plain
`capshelf add`.

`--from` still works for prepared source files (for mcp it requires
`--target`, since a file's destination can't be inferred), and the two are
mutually exclusive.

## Keep a team in sync

The full loop — teammate A improves a skill, teammate B picks it up — now
has first-class support.

**`sync-data`** pulls teammates' changes into your data repo clone,
explicitly and safely:

```bash
capshelf sync-data     # fetch origin; fast-forward only when provably safe
capshelf status        # items now show "update available"
capshelf update security-review
```

It never merges, never rebases, never touches your project files, and stops
with clear guidance when your clone has diverged or has local edits. It is
the only network verb besides the `init` bootstrap clone and `self-update`
— no other command will ever fetch behind your back.

**Stale-promote protection.** If a teammate's newer version of an item
reached the data repo since your project last updated, `promote` now
refuses instead of silently overwriting their work, and tells you how to
look at what changed. `--stale-ok` exists for the deliberate overwrite. If
what you're promoting turns out to be identical to what's already upstream,
promote reports `already-upstream` and just re-pins your lock — no
duplicate commit.

**An honest CI gate.** `status` now also verifies that every locked
`sourceCommit` still exists in the data repo and reports
`missing_source_commit` when it doesn't — the state you end up in when a
promote was merged upstream as a squash. `status --strict` (exit 4) catches
it, and `capshelf update <item>` heals it.

**The recipes are written down.** `docs/team-workflow.md` covers proposing
changes upstream through a normal PR (branch in the data repo → `promote` →
push → `gh pr create`), the fork and patch variants for read-only
consumers, the post-merge re-pin step, and a paste-able GitHub Actions
workflow that gates project PRs on `capshelf status --strict`. The bundled
skill teaches agents the same recipes.

## A written security position

`SECURITY.md` and `docs/security.md` are new. The short version: shared
settings and MCP fragments are code-adjacent (hooks execute, MCP servers
run as you), so treat data-repo review like code review. Capshelf's
contribution is pinning (`sourceCommit` + content hash), explicit-only
network behavior, and `status --strict` in CI; permissions, branch
protection, and review on the data repo — your git host's controls — are
the control plane. Vulnerability reports go through GitHub's private
reporting on the repo.

## Smaller improvements

- `set-data` and `set-upstream` now support `--json`.
- `ls`, `search`, and all bundle/metadata JSON additions are append-only —
  existing scripts keep parsing.
- Item names and refs containing `:` are now rejected; the character is
  reserved for future shelf-qualified refs (`shelf:kind/name`) so projects
  created today stay compatible with multi-shelf federation later. A
  `shelves` key in `.capshelf/capshelf.json` or `local.json` fails loudly
  for the same reason.
- TOML date values in codex fragments remain unsupported, but the rule is
  now documented (docs/cli.md) instead of being an unexplained error.
- An empty `.mcp.json` or `.claude/settings.json` is now treated like a
  missing one (matching TOML, where empty input is an empty table) instead
  of failing with a bare `JSON Parse error: Unexpected EOF`. When one of
  these files is genuinely malformed, the error now names the file.

## Breaking changes

- **`promote --create` is removed** (deprecated since 0.3). Use
  `capshelf share <item> --to project` instead.
- **`:` in item names is rejected.** Rename any data-repo item directory
  containing a colon (none are expected in practice).

## Upgrading

```bash
capshelf self-update        # Homebrew installs
# or re-run the install script / git pull && make install for source installs
```

No migration steps: manifests, lockfiles, and data repos from 0.3 are
read and written unchanged.
