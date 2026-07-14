# Spec: Claude Code subagent support (`agents` item kind)

Status: draft
Date: 2026-07-14

## Summary

Add a fifth item kind, `agents`, that shares Claude Code subagent definitions
across projects the same way `skills` shares skill directories. A subagent is
a copy item: a directory in the data repo materialized whole into the project,
hash-pinned in the lock, round-tripped with `share`/`promote`. No new
reconciliation machinery is required; the work is mostly registering the kind
plus subagent-specific validation and warnings.

```bash
capshelf add agents/security-reviewer
capshelf status
capshelf promote agents/security-reviewer -m "tighten SQLi checklist"
```

## Background

A Claude Code subagent is a single Markdown file whose YAML frontmatter is
configuration and whose body becomes the subagent's system prompt. Claude Code
discovers definitions by scanning `.claude/agents/` (project scope) and
`~/.claude/agents/` (user scope) **recursively**; identity comes from the
frontmatter `name` field, never the filename or subdirectory path. Precedence
when names collide: managed (enterprise) > CLI `--agents` flag > project >
user > plugin.

Only `name` and `description` are required. Optional fields include `tools`,
`disallowedTools`, `model`, `permissionMode`, `maxTurns`, `effort`, `memory`,
`background`, `isolation`, `color`, `initialPrompt`, and two that reference
other configuration by name: `skills` (skills preloaded into the subagent's
context) and `mcpServers`.

Claude Code watches the agent directories and picks up edits live, which makes
the capshelf drift loop (edit in place → `status` shows drift → `promote`)
the natural workflow.

Unlike skills, there is no cross-tool standard for this format: it is
Claude-specific. Codex has a parallel concept (TOML files under
`.codex/agents/`) already reserved in `docs/architecture.md` as a planned
separate kind; it is out of scope here.

## Goals

1. Track subagent definitions as first-class data items: `add`, `status`,
   `apply`, `update`, `rm`, `revert`, `share`, `move`, `promote`,
   `keep-local`, `ls`, `show`, `search`, and bundle membership all work.
2. Preserve every existing invariant: lock as ownership boundary,
   parallel-PR safety, sidecar-blind hashing, untracked files ignored.
3. Validate the subagent-specific format at the points where capshelf already
   enforces item quality (`share` at the door, warnings elsewhere).
4. Surface subagent-specific hazards Claude Code itself handles poorly:
   duplicate frontmatter names (undefined load order) and dangling
   `skills:`/`mcpServers:` references (silently degraded agents).

## Non-goals

- **Codex custom agents** (`codex/agents/<name>` → `.codex/agents/*.toml`).
  Same copy-item pattern, separate follow-up spec; the formats do not
  round-trip and should not share a kind.
- **`.claude/commands/`.** Already rejected; commands are skills.
- **User-scope installs** (`~/.claude/agents/`). Capshelf materializes into
  projects only. Personal agents remain external, as personal skills do.
- **Cross-harness compilation** (one definition rendered for Claude, Codex,
  OpenCode, …). Interesting, lossy, out of scope.

## Design

### Kind name

The kind is `agents`, data-repo directory `agents/`. This follows the
established convention that unprefixed top-level data-repo directories are
Claude surfaces and Codex surfaces live under `codex/` (`codex/config/`,
future `codex/agents/`).

Known confusion risk: the kind installs to `.claude/agents/`, **not** to the
project's `.agents/` directory (the Codex-compatible skills base dir). Docs
and `show` output must state the install path explicitly. `subagents` was
considered as the kind name to avoid this collision but loses the naming
symmetry with the upstream directory and the future `codex/agents/` sibling.

### Data repo layout

```
<data-repo>/
└── agents/
    └── <name>/
        ├── AGENT.md          canonical file: frontmatter + system prompt
        └── .capshelf.yml     optional metadata sidecar (existing schema)
```

Directory-per-item, like skills, even though the deliverable is one file:

- The existing walk/hash/materialize/promote machinery works unchanged on
  directories.
- The `.capshelf.yml` sidecar has a well-defined home ("item directory
  root"); a flat `agents/<name>.md` layout would need a new sidecar
  placement rule.
- Leaves room for future supporting files if the upstream format grows them.

`AGENT.md` is the canonical filename (mirrors `SKILL.md`). Claude Code does
not care about filenames, so this is a capshelf convention only:
`isInstallableDataItem` for `agents` requires `agents/<name>/AGENT.md` to
exist, exactly as fragment kinds require their canonical files. Extra files in
the item directory are allowed, hashed, and materialized, but discouraged —
Claude Code will attempt to parse any additional `.md` file in the installed
tree as another agent definition.

### Installed layout

```
<project>/.claude/agents/<name>/AGENT.md
```

Same path in **both** install modes (`codex-compatible` and `claude-only`).
Subagents are Claude-only surfaces: there is no second consumer to alias for,
so the `.agents/` + symlink indirection used by skills buys nothing.
`ensureInstallAliases`/`removeInstallAliases` are no-ops for this kind.

Claude Code's recursive scan makes the per-item subdirectory valid; the
subdirectory does not affect the agent's identity or invocation name.

### Manifest, local config, lock

- `.capshelf/capshelf.json` gains `agents: string[]` (default `[]`).
- `.capshelf/local.json` gains `agents: string[]` (default `[]`). Local scope
  works exactly as it does for skills, including `.git/info/exclude` entries
  for `.claude/agents/<name>/` in Git projects. Subagents are frequently
  personal workflow tools, so local scope ships in v1 rather than as a
  follow-up.
- Lock keys: `data/agents/<name>` and `system/agents/<name>` (no system
  agents are bundled initially; the schema supports them for free).
- Item refs: `agents/<name>`; bare `<name>` resolves across kinds via the
  existing ambiguity rules.
- Bundles: `includes.agents: [<name>, …]`, expanded like every other kind.

### Hashing and versioning

Unchanged copy-item semantics: truncated sha256 over the sorted file list,
sidecar excluded from hashing and materialization, `sourceCommit` computed by
`lastTouchingContentCommit` with the sidecar-excluding pathspec. Frontmatter
edits **do** bump the sha — frontmatter ships to Claude and changes runtime
behavior (hashed iff delivered), same rationale as skill frontmatter.

## Command behavior

All commands inherit generic copy-item semantics. Deltas:

### `add`

- Refuses when `.claude/agents/<name>/` exists and is not lock-owned
  (standard conflict rule). A pre-existing **flat file**
  `.claude/agents/<name>.md` is also a conflict for `agents/<name>`: the
  installed agent would silently duplicate it. The error message points at
  `share` (adopt) or `rm` of the flat file.
- After materializing, runs [validation](#validation) in warning mode and
  emits [reference warnings](#reference-warnings) for dangling
  `skills:`/`mcpServers:` entries. Warnings never change the exit code.
- Sidecar `requires`/`conflicts-with` behave as for other kinds.

### `share`

- Adopts either an on-disk directory `.claude/agents/<name>/` **or a flat
  file** `.claude/agents/<name>.md`. The flat-file form is the common
  hand-rolled layout; `share` converts it: writes
  `agents/<name>/AGENT.md` in the data repo, then replaces the project file
  with the managed directory layout on the same invocation. The conversion is
  reported in output since it moves a path inside the user's repo.
- Runs [validation](#validation) in **blocking** mode (exit 3): a shared item
  must have parseable frontmatter with `name` and `description`. Quality is
  enforced at the door, matching `share`'s role.

### `promote`

- Standard promote flow. Validation runs in warning mode — blocking here
  could strand a user trying to push a fix through the data repo.

### `status`

- Standard drift/upstream reporting.
- The external section gains `external/ (Personal Claude)` entries for
  `~/.claude/agents/` definitions whose frontmatter `name` matches a managed
  agent. Note the inverted direction vs skills: for subagents, **project
  beats user**, so the personal definition is the shadowed one. This is
  informational only and never trips `--strict` — the managed item wins at
  runtime, which is the desired state.
- Reports [runtime warnings](#runtime-warnings).

### Everything else

`apply`, `update`, `rm`, `revert`, `move`, `keep-local`, `ls`, `show`,
`search`: no kind-specific behavior beyond registration. `show` displays the
frontmatter `description` (fallback when the sidecar has none, mirroring the
SKILL.md frontmatter fallback) and the install path. `rm` removes the managed
directory; it never touches unmanaged flat files.

## Validation

Applied to `AGENT.md` at the item root:

1. File exists (structural — enforced by `isInstallableDataItem` for data
   items and by `share` for adoption).
2. Frontmatter parses as YAML.
3. `name` and `description` are present and non-empty.
4. Frontmatter `name` equals the item name. A mismatch is legal for Claude
   Code (identity is the frontmatter) but makes every capshelf surface
   (`add agents/<dir-name>`, lock keys, status rows) disagree with the
   `@`-mention name the user sees in Claude. Warn; do not block.

Checks 2–4 run in blocking mode for `share` (exit 3, standard refusal
formatting) and warning mode everywhere else (`add`, `promote`, `apply`,
`status`). Warning mode exists because data repos may contain items authored
before this validation or by other tools; capshelf reconciles state, it does
not quarantine it.

Frontmatter parsing reuses the existing SKILL.md frontmatter reader; no new
YAML dependency.

## Runtime warnings

Extend `runtime-warnings.ts` (currently `shadowed_by_personal_claude_skill`,
`codex_project_untrusted`) with:

- `duplicate_claude_agent_name` — another file under the project's
  `.claude/agents/` tree (managed or not) declares the same frontmatter
  `name`. Claude Code resolves duplicates within one scope by filesystem read
  order, i.e. undefined behavior; this is the highest-value check in the
  spec. Detection scans `*.md` files under `.claude/agents/`, tolerating
  unparseable files silently.
- `agent_skill_not_installed` — a frontmatter `skills:` entry names a skill
  that is neither a project skill (managed or not, via the installed skills
  directory for the active mode) nor a personal skill under
  `~/.claude/skills/`. The subagent will run without its preloaded context —
  a silently degraded agent.
- `agent_mcp_server_not_configured` — a frontmatter `mcpServers:` string
  entry (server *reference*, not inline definition) names a server absent
  from the project's `.mcp.json`. Inline object entries are self-contained
  and skipped.

All three surface through the existing `runtimeWarnings` channel
(materialize results, `status` human and JSON output) and never affect exit
codes, including `--strict`. They are advisory: the reference checks in
particular can false-positive on servers configured in user-level Claude
settings capshelf does not read.

## Compatibility

- **Old CLI, new lock**: `parseLockKey` throws on the unknown `agents` kind,
  so any lock-reading command fails loudly with "unsupported lock key kind"
  and the supported-kinds list. Loud failure forcing an upgrade is the
  intended behavior; the error message already names the supported kinds so
  the version mismatch is diagnosable.
- **Old CLI, new manifest, no agent lock entries yet**: the non-strict
  manifest schema strips the unknown `agents` key and the next `saveManifest`
  deletes it silently — the same hazard class the `shelves` guard exists for.
  This edge requires a manifest that declares agents none of which ever
  locked, which no capshelf write sequence produces (`add` writes manifest
  and lock together). Accepted risk; release notes must state the minimum
  CLI version for projects using agents.
- **skills.sh / plugins**: no interaction. skills.sh does not manage agents;
  plugin agents are namespaced (`plugin:agent`) and cannot collide with
  project agents, so no external-ownership tracking is needed.
- **`commands` precedent**: none. The rejected `commands` manifest key
  remains rejected.

## Implementation notes

Registration touch points (the compiler surfaces most of these via the
`ItemKind` union):

- `master.ts` — add to `ITEM_KINDS` (keep `FRAGMENT_ITEM_KINDS` unchanged;
  update `isFragmentItemKind` from `!== "skills"` to a membership check),
  `itemRepoRelPath` (`agents/${name}`), `allCanonicalItemRelPaths`
  (`agents/<name>/AGENT.md`), `masterListDir`, `isInstallableDataItem`
  (require `AGENT.md`).
- `installed.ts` — `installedPath` case returning
  `join(claudeDir(project), "agents", name)`; alias helpers stay
  skills-only.
- `manifest.ts` / `local-config.ts` — `agents` arrays plus
  `manifestNamesForKind` case; local-scope plumbing mirrors skills.
- `runtime-warnings.ts` — the three new warning types; frontmatter reader
  shared with the metadata module.
- `bundles.ts`, `search-core.ts`, `status-*`, command modules — kind
  registration only, plus the `share` flat-file adoption path and `add`
  flat-file conflict check.
- Docs: `architecture.md` (layout tables, apply-strategy table — replace the
  `codex/agents` "planned" row context), `cli.md`, bundled bootstrap
  SKILL.md if it enumerates kinds.

## Testing

- Unit: kind registration (ref parsing, lock keys, manifest round-trip,
  installed paths per mode), frontmatter validation matrix, each runtime
  warning, flat-file share conversion, flat-file add conflict.
- Smoke (`make smoke` suite addition, mirroring `smoke-skills`): full loop —
  data repo with an agent → `add` → drift via edit → `status` →
  `promote` → second project `update`; `share` of a hand-rolled flat
  `.claude/agents/foo.md`; local-scope add in a Git project verifying
  `.git/info/exclude`.

## Future work

- `codex-agents` kind: `codex/agents/<name>/agent.toml` →
  `.codex/agents/<name>.toml`; validation of required `name`/`description`/
  `developer_instructions` keys. Sibling spec once the upstream format
  stabilizes.
- Dependency graph in `show`: render frontmatter `skills:`/`mcpServers:`
  references with install state, alongside sidecar `requires`.
- Optional user-scope target (`~/.claude/agents/`) if a machine-level
  manifest ever exists; out of scope while capshelf is project-rooted.
