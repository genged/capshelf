# TODO

## Security / release engineering

### Pin third-party GitHub Actions to commit SHAs (MED)

Both workflows pin actions to mutable major-version tags, not immutable commit
SHAs. A tag like `@v2` is a git ref the upstream owner can move at any time, so
each run executes whatever that tag currently points at — not what was
reviewed.

Unpinned actions:

| File | Line(s) | Action | Currently |
|---|---|---|---|
| `.github/workflows/release.yml` | 56, 81 | `actions/checkout` | `@v4` (first-party) |
| `.github/workflows/release.yml` | 61, 86 | `oven-sh/setup-bun` | `@v2` (third-party) |
| `.github/workflows/test.yml` | 24, 40 | `actions/checkout` | `@v4` (first-party) |
| `.github/workflows/test.yml` | 27 | `biomejs/setup-biome` | `@v2` (third-party) |
| `.github/workflows/test.yml` | 43 | `oven-sh/setup-bun` | `@v2` (third-party) |

**Why it matters:** the `release` job (`release.yml:72`) runs with
`permissions: contents: write` and holds `GH_TOKEN`, and it runs the
third-party `oven-sh/setup-bun@v2` right before building and uploading the
published Homebrew binaries. If that action (or its `v2` tag) is ever
compromised — maintainer takeover, a moved tag, a poisoned dependency — the
attacker's code runs in the privileged release job and could exfiltrate the
write token or tamper with the artifacts every `brew install` /
`install.sh` user then downloads. (This compounds with the missing
artifact-signing item below: nothing downstream would detect a swap.) MED
because it requires an upstream compromise first, not currently exploited.

**Fix:**
1. Pin every third-party action to a full 40-char commit SHA with the version
   in a trailing comment. Prioritize the two third-party actions in the
   write-privileged release path; `actions/checkout` (first-party) is lower
   priority but fine to pin for consistency.
   ```yaml
   - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6   # v2
   - uses: biomejs/setup-biome@a05c02a1304287da45f13648675a70d5841acdbc  # v2
   ```
   (SHAs resolved 2026-07 via `git ls-remote`; re-resolve before applying —
   `git ls-remote https://github.com/OWNER/REPO <tag>`, append `^{}` to
   dereference an annotated tag to its commit.)
2. Add `.github/dependabot.yml` with the `github-actions` ecosystem so future
   bumps arrive as reviewable PRs that update both the SHA and the comment —
   keeping the security of an immutable pin without hand-maintaining hashes.
   ```yaml
   version: 2
   updates:
     - package-ecosystem: "github-actions"
       directory: "/"
       schedule:
         interval: "weekly"
   ```

### Sign / provide provenance for release artifacts (MED)

`scripts/install.sh` verifies a SHA-256 checksum, but the checksum ships from
the same GitHub release as the tarball, so it proves transport integrity, not
authenticity — anyone who can alter the release controls both. Add artifact
signing (minisign/cosign) or SLSA build provenance and verify it in
`install.sh` against a pinned public key.

### Secret-scan gaps on share/promote (LOW)

Only `.env*`-named files trigger the private-dotenv warning when adopting an
on-disk file into the shared data repo; a token embedded directly in
`settings.json`/`.mcp.json`/`config.toml` is committed without a warning. Also,
`filesystemSnapshot` (local scope / non-git projects) honors only in-tree
`.gitignore`, not `.git/info/exclude` or the global excludes file, so a secret
excluded only by those could be adopted. Consider a broader "looks like a
secret" heuristic, and use `git check-ignore` (covers info/exclude + global
excludes) instead of parsing tree `.gitignore` files. Explicitly out of scope
per `docs/security.md` today ("no capability scanning") — capture the decision
either way.

## Agentic-domain fit

### Validate settings/.mcp fragments against their schema (MED)

`validateClaudeSettingsFragment` (`json-fragments.ts:48`) and the `.mcp.json`
server check are effectively no-ops (`return value`). A fragment with
`permissions: {allow: "Bash(...)"}` (string, not array), a malformed `hooks`
shape, or an `.mcp.json` server entry missing `command`/`url`/`type` merges
cleanly and is then silently ignored by Claude Code — the worst failure mode
for a config manager. Validate fragments against the settings schema (the
schemastore URL is already pinned) at `add`/`promote` time.

### Support shared hooks / agents / CLAUDE.md (MED)

A settings fragment can carry `hooks` config, but the fragment kind is exactly
one file (`settings/<name>/settings.json`), so there's no way to ship the
hook's *script* — a shared `PreToolUse` hook referencing `.claude/hooks/x.sh`
merges into projects that lack the script. Likewise absent: `.claude/agents/*.md`
subagents, CLAUDE.md/AGENTS.md sharing, output styles. For real team workflows
these rank above codex-config fragments. Add an `agents` copy kind and let
settings items be directories whose non-settings files materialize under
`.claude/`.

### Managed-settings path drift on Windows + drop-in dirs (MED)

`external.ts` uses `C:\ProgramData\ClaudeCode\managed-settings.json`; current
docs say `C:\Program Files\ClaudeCode\managed-settings.json`, and
`managed-settings.d/` drop-in directories (macOS/Linux) aren't scanned. Impact
is limited to plugin external-state reporting, but it's exactly the convention
drift the tool exists to prevent.

### User-level (`~/.claude`) scope (MED)

All outputs are project paths (`installed.ts`). The README pitch ("as you
accumulate projects, you accumulate copies…") equally describes `~/.claude/skills`
and user settings — the classic dotfiles case — which capshelf can't manage;
personal skills are only ever a warning source. Add a `--scope user` install
target, or state the non-goal explicitly in the README.

### Agentic-domain LOW

- Stale error hint (`master.ts:43`) suggests placing a data repo at
  `~/code/capshelf-data`; no such implicit default exists (`paths.ts` documents
  "no implicit default (ADR-009)"). Following the hint does nothing.
- Fragment removal can delete user-authored duplicates: `removeManagedValue`
  (`config-values.ts`) subtracts array entries by exact value, so `rm` of a
  fragment also removes a rule the user hand-added that happened to match.
  Document, or track provenance per entry.
- TOML integer edge: smol-toml yields `bigint` for integers beyond 2^53;
  `validateTomlValue` (`toml-fragments.ts`) rejects it with a generic
  "unsupported TOML value bigint" rather than the clear message dates get.
- `SKILL.md` frontmatter `description` states capability but not invocation
  cues; best practice includes when-to-use phrasing (which already exists in
  the body). The embedded command table can drift from the CLI ("always check
  `--help`" mitigates).
- `.claude/skills/<name>` symlinks break on Windows checkouts with
  `core.symlinks=false` (materialized as text files → skill silently not
  loaded). Undocumented in README/SKILL.md.
- README framing ("Shared Agent Configuration" / "coding-agent configuration")
  reads multi-tool; actual support is exactly Claude Code + Codex. Tighten the
  tagline or name the two tools up front.

## Robustness

### Non-atomic promote dir-replace (LOW)

`promote` replaces the data-repo item dir with rm-then-copy
(`sync.ts` `replaceDir*`); a crash between the rm and the copy leaves the item
half-written before any commit. Recoverable via `git checkout` (git-backed), so
bounded, but the window exists and the sidecar cache/restore straddles it. Stage
into a temp dir and swap.

## Architecture

### Architecture LOW cleanups

- Dead exports with no call sites: `itemKey` (`lock.ts`), `allFragmentTargets`,
  `fragmentTargetsForKinds`, `assertFragmentKind` (`fragments.ts`). Also
  pure-alias indirection: `currentFragmentSourcesForItem` ≡ `fragmentSources`,
  `isFragmentKind` ≡ `isFragmentItemKind` — pick one name per pair.
- Magic sentinel: `commands/status.ts` assigns the string
  `"fragment-output-drift"` to a `currentSha: string | null` field, so it flows
  into `--json` output as if it were a content hash. Let `currentSha` be `null`
  for drifted fragment outputs and expose the state as its own row field.
- Manifest shape described three ways: `ManifestSchema`, the `Manifest` type
  intersection (`manifest.ts`), and `detectInstallMode`'s
  `ManifestInstallModeSchema` (`paths.ts`). Derive the mini-schema from a shared
  base so they can't drift.

## Developer experience — contributor

### Contributor LOW

- No `CONTRIBUTING.md` or PR template; `AGENTS.md` (the de facto substitute)
  references a monorepo that doesn't exist (`packages/*`) and says to install
  Biome ad hoc though `@biomejs/biome` is already a pinned devDependency. Add a
  short CONTRIBUTING pointing at `make check`, the smoke-suite layout, and the
  tag → release-workflow process; fix the stale AGENTS.md paragraphs.
- CI reproducibility & platform coverage: `test.yml` uses `bun-version: latest`
  (pin + add a scheduled canary); `release.yml` cross-compiles darwin artifacts
  but only tests on ubuntu — no macOS job, and no smoke run against the compiled
  `dist/capshelf` binary (all smoke runs use `bun run src/cli.ts`).
- Papercuts: `Makefile` `clean` removes `bun.lockb` but the repo uses text
  `bun.lock` (and deleting a committed lockfile on clean is undesirable anyway);
  `init` "next:" hints suggest `capshelf add bundles/<name>` even when the bound
  data repo has no `bundles/` directory.
