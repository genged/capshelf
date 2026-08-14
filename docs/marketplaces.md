# Plugin marketplaces

Marketplace commands operate on the resolved Git data repo and work outside a
Capshelf project with `--data` or `$CAPSHELF_HOME`. Plugin definitions are
catalog state, not items: no project manifest or lock is changed.

```bash
capshelf marketplace init --target claude --name company --owner Engineering
capshelf marketplace init --target codex --name company-codex --owner Engineering
capshelf marketplace plugin create engineering --target claude \
  --skill skills/code-review --skill skills/test-planning
capshelf marketplace plugin create engineering --target codex \
  --skill skills/code-review
capshelf marketplace ls
capshelf marketplace show engineering
capshelf marketplace validate
```

Target mutations require `--target claude|codex`. Supported mutations are
marketplace `init`/`edit` and plugin `create`/`edit`/`add-skill`/
`remove-skill`/`rename`/`delete`. They require a clean data repo, validate the
complete target, stage only owned paths, create one local commit, never push,
and support `--dry-run`, `--json`, and `-m`. A failed commit restores the
source, generated paths, index, and HEAD when Capshelf still owns the observed
HEAD. If another process commits concurrently, Capshelf never rewinds that
commit; it restores only unchanged owned roots that are safe to restore.
Claude preserves structurally external entries but refuses to mutate them.

Marketplace and plugin identities use kebab-case. Claude marketplace names
also reject Anthropic's current reserved names and obvious official
impersonation. `plugin create` requires at least one selected skill. Codex
installation policy accepts `NOT_AVAILABLE`, `AVAILABLE`, or
`INSTALLED_BY_DEFAULT`; authentication policy accepts `ON_INSTALL` or
`ON_USE`. Options that do not apply to the selected target are errors.

Codex source definitions live under `codex/plugin-definitions/`. The generated
native catalog and self-contained plugin roots live at
`.agents/plugins/marketplace.json` and `codex/generated/`. Run:

```bash
capshelf marketplace sync --target codex --dry-run --json
capshelf marketplace validate --target codex
codex plugin marketplace add /path/to/data-repo
```

Sync reads dirty definitions and skills, repairs only generated paths, and
never stages or commits. Clean committed projection drift is repaired without
a prompt. Dirty affected projection paths are listed and require interactive
consent or `--yes`; review them first with the dry-run above. Skill `share` and `promote` regenerate the complete
configured Codex projection in the same source commit. Codex generated plugin
versions are deterministic `0.0.0+codex.<hash>` cachebusters. Codex
initialization refuses any pre-existing source or generated root instead of
claiming or deleting unknown files.

`marketplace validate --json` returns target-labeled `configured` and `valid`
state, Codex projection/source paths, Claude repository and selected-plugin
file/byte totals and known Cowork limits, and Codex
canonical/generated/duplicated byte totals.
Validation issues are structured objects with stable `code`, `message`, and
target-specific fields. `--distribution` validates hosted Claude distribution
and requires a configured Claude marketplace. `--cowork-url` is valid only
with `--distribution`; an invalid URL stays in the full validation report and
exits 4. A valid explicit URL is reported as user-asserted support and emits a
structured warning, so `--strict` exits 4. `--target` and `--distribution` are
mutually exclusive.

`marketplace plugin pack` requires a target and an output outside the data
repo. Claude produces a deterministic root-content `.plugin` ZIP for Cowork
upload; Codex produces a detached one-plugin marketplace directory. Packaging
uses current Git-visible working-tree bytes by default; `--from-head` selects
committed bytes. Symlinks, private dotenv files, unsafe output containment,
unsafe generated paths, and non-identical output replacement are refused.
Containment follows real paths through the nearest existing ancestor, so a
lexically external output cannot re-enter the data repo through a symlink.
Tracked files use Git executable intent; untracked files use filesystem mode.
Rebuilding identical output returns `already-built`.

Plugin membership must always name existing canonical skills. For a direct
data-repo skill rename, rename the skill and update every Claude/Codex
membership in the same Git change, then run Codex sync and marketplace
validation. Remove all memberships before deleting a skill. Dangling selected
skills block validation, sync, pack, and catalog mutations.

Capshelf prints runtime handoff commands but does not register marketplaces,
install plugins, update caches, push commits, or claim a runtime accepted the
result.

See [cli.md](cli.md) for the project command surface these catalogs sit beside.
