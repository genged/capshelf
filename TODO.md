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
