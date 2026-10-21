# What's new in capshelf 0.14

## Summary

- A new item kind, `plugins/<name>`, copies a whole Claude Code plugin
  directory into a project. The plugin's agents, hooks, scripts, and MCP
  servers come with its skills.
- Capshelf lists the hooks and the MCP servers that a plugin runs. It asks
  before it puts those commands where Claude Code runs them.
- `capshelf add <url>` installs a whole plugin from any Git repository.
  `--list` and the picker now show plugins.
- `status` counts what each plugin runs. It also tells you when Claude Code
  does not trust the workspace.
- One skill folder has one owner. A second item that installs into the same
  folder is refused.
- The project lock moved to version 5. Each project must run
  `capshelf lock migrate` once. Capshelf 0.13 cannot read a version 5 lock.

Capshelf 0.13 could copy one skill out of a plugin. That copy can break the
skill, because a skill can read other plugin files through
`${CLAUDE_PLUGIN_ROOT}`. Capshelf
0.14 copies the whole directory into the folder that a skill uses:

```text
data repo                            project
plugins/gh-cli/                      .agents/skills/gh-cli/
  .claude-plugin/plugin.json  ---->    .claude-plugin/plugin.json
  skills/gh-cli/SKILL.md               skills/  hooks/  ...
  hooks/hooks.json                   .claude/skills/gh-cli -> ../../.agents/skills/gh-cli

Claude Code loads the folder as gh-cli@skills-dir in a trusted workspace.
Codex sees the skills only.
```

The full command surface is in [Plugins](cli.md#plugins) and
[Whole plugins](cli.md#whole-plugins) in the command reference.

## Do I need to do anything?

| If you | Then |
|---|---|
| upgrade from 0.13 | Run `capshelf lock migrate` once in each project, then commit the project lock |
| share a project with teammates | Upgrade every teammate's capshelf before you commit the version 5 lock |
| track `skills/capshelf` | Run `capshelf update skills/capshelf` after the lock migration |
| want a plugin on your shelf | Put it under `plugins/<name>/` in the data repo, then run `capshelf add plugins/<name>` |
| want a plugin from a public repository | Run `capshelf add <url> --path <plugin-dir>` |
| script an `add` of a plugin that runs commands | Pass `--yes`. With no terminal, the add refuses with exit 3 |
| install from Homebrew | Run `brew trust --formula genged/tap/capshelf` once, so `brew upgrade` sees capshelf |
| use plugins only from Claude marketplaces | Nothing changes. Their `status` rows now print as `claude-plugins/<id>` |

## Plugins on your shelf

A directory under `plugins/` in the data repo is an item when it holds
`.claude-plugin/plugin.json` as a regular file. The `name` in that manifest
is the item name, because Claude Code names the plugin from that field.
Capshelf never edits `plugin.json`.

```text
plugins/<name>/
  .claude-plugin/plugin.json   required. Its "name" is the item name
  .capshelf.yml                optional catalog metadata, never installed
  skills/  agents/  hooks/  scripts/  ...
```

A plugin has the same lifecycle as a skill, in project scope or local scope.
These commands accept it: `add`, `share`, `move`, `apply`, `update`,
`update --merge`, `promote`, `keep-local`, `revert`, and `rm`. A bundle can include `plugins` members.

```bash
capshelf add plugins/gh-cli --yes
```

```text
  plugin    plugins/gh-cli
  runs      1 hook, with no request from the agent
              SessionStart   bash hooks/setup.sh
            These hooks run in every Claude Code session in this project.
  project scope commits it. The hooks then run in every teammate's
  Claude Code session after they trust this workspace.

  capshelf does not review this content. Your agent runs it with your permissions.
✓ added project/data/plugins/gh-cli @ a585050f8c42
  source commit: d7838181644365622f06bee1fe36c82e6d3f1833
  /home/mg/code/my-app/.agents/skills/gh-cli
  Claude Code loads it as gh-cli@skills-dir in a trusted workspace
```

Claude Code calls the plugin's skills `gh-cli:<skill>` and its agents
`gh-cli:<agent>`. Capshelf writes no Claude or Codex setting, cache, or
catalog to make the plugin load. A plugin item needs no `enabledPlugins`
entry.

## Capshelf asks before a plugin runs commands

A hook runs on a Claude Code event. An MCP server starts with the session.
Neither waits for a request from the agent. Capshelf reads both from the
pinned tree and shows each one with its command.

Capshelf does not list monitors, LSP servers, or a manifest key that it does
not know. It reports each of them as `unknown`. A declaration that it cannot
read is also `unknown`. An `unknown` entry never reads as "no hooks".

Capshelf asks at three points:

| Point | When it asks |
|---|---|
| Install | `add plugins/<name>` when the plugin has an entry. `add <url>` always asks |
| Pin move | A shelf `update` when the new tree adds an entry. A remote `update` always asks |
| Project scope | `add` in project scope, `move --to project`, and `share --adopt --to project` |

A changed command counts as a new entry. A removed entry asks nothing. One
command asks once, for all of its points. With no terminal, or with `--json`,
each point refuses with exit 3 unless you pass `--yes`.

A shelf `update` has one limit. A script can change while its hook line
stays the same. That is not a new entry, so the update does not ask. Review
the diff first:

```bash
capshelf status plugins/gh-cli --diff-view upstream
```

A skill whose folder holds `.claude-plugin/plugin.json` is a plugin to
Claude Code, which runs its hooks. Capshelf gives that skill the same
consent points.

## Install a whole plugin from any repository

`--path` that names a plugin directory installs the whole plugin, when the
directory holds `.claude-plugin/plugin.json`:

```bash
capshelf add https://github.com/acme/agent-plugins --path plugins/gh-cli
```

```text
  repo      https://github.com/acme/agent-plugins
  ref       main
  commit    bda04843d5e643a1f1926849e6705bea19250b9c
  path      plugins/gh-cli
  plugin    gh-cli 1.6.2
  install   .agents/skills/gh-cli  (local scope, gitignored)
  files     4 files, 183 B
              skills/          1 file    47 B
              .claude-plugin/  1 file    36 B
              hooks/           2 files  100 B
  skills    1, called as gh-cli:<skill>
              gh-cli
  runs      1 hook, with no request from the agent
              SessionStart   bash hooks/setup.sh
            These hooks run in every Claude Code session in this project.
  codex     sees the skills only
  license   none found in the item or at the repo root

  capshelf does not review this content. Your agent runs it with your permissions.
Install it? [y/N]
```

The item name comes from `plugin.json`, so `--as` refuses. The record key is
`remote/plugins/<name>`. A named `update plugins/<name>` asks for every pin
move. Its prompt adds the `version` line from `plugin.json` and the new
`runs` entries. `share plugins/<name> --adopt` moves a pulled plugin onto the
shelf.

A `--path` to a skill inside a plugin still installs that skill only. A
plugin directory with no `.claude-plugin/plugin.json` refuses, and the
refusal names the skills it holds.

## See what a repository holds

`--list` now reads two plugin catalogs: `.claude-plugin/marketplace.json` and
`.agents/plugins/marketplace.json`. It groups skills under their plugins:

```bash
capshelf add https://github.com/acme/tools --list
```

```text
  repo      https://github.com/acme/tools
  ref       main
  commit    4d319a53b593bd41a74ffd8c099482fff93d46ca
  found     2 plugins and 1 skill  (.claude-plugin/marketplace.json)

  plugins/gh-cli   plugin gh-cli: GitHub CLI helpers   also ships: agents, hooks
    gh-cli      Use gh

  plugins/review   plugin review: Code review
    diff        Read a diff
    style       Check style

    skills/pdf   Extract text

  install one:   capshelf add https://github.com/acme/tools --path plugins/gh-cli/skills/gh-cli
  install some:  capshelf add https://github.com/acme/tools
  details:       capshelf add https://github.com/acme/tools --list --json
  install a whole plugin:  capshelf add https://github.com/acme/tools --path plugins/gh-cli
  Codex sees the skills only.
```

The picker unit follows the shape of the repository. A catalog of plugins
with manifests shows plugins. A repository of skill folders shows skills. A
repository with both shows two sections, plugins first.

A skill can use plugin parts outside its own directory, such as a root
script or a sibling agent. `--list` reports this in a "uses" column. The
check reads text only, so it can be wrong in both directions. It never
blocks an install.

A listing taller than the terminal asks once before it prints the rest. A
pipe, `--json`, and `--yes` skip the question.

## One folder, one owner

A plugin installs into the same folder as a skill with its name. The shelf
can hold `skills/<name>` and `plugins/<name>` together, so each project can
switch on its own schedule. A project can install only one of them.

A write that would give a folder a second owner refuses with exit 3, and
prints the switch:

```text
✗ .agents/skills/rust-review is already installed by data/plugins/rust-review (project scope)
  a project uses one of plugins/rust-review and skills/rust-review. To switch:
    capshelf rm plugins/rust-review
    capshelf add skills/rust-review
  after the switch, Claude Code calls the skill /rust-review (was rust-review:<skill>)
```

The check compares folders, with case and Unicode folding. Every owner
counts: both locks, a remote row, a skills.sh row, and an unmanaged folder.
`rm` does not refuse. It removes its own record and keeps a folder that
another owner claims.

## Plugins in status

A plugin row ends with what it runs. A count of zero prints nothing:

```text
project/
  ✓   data/plugins/gh-cli                     a585050f8c42  up-to-date   hooks: 1
      Claude Code does not load plugins in an untrusted workspace. Open the project in Claude Code and trust it.
```

The row can end with `hooks: <n>`, `MCP: <n>`, and `runs: unknown`. The
counts come from the installed copy.

`status` reads workspace trust from `~/.claude.json` the way Claude Code
does. It never writes that file. The hint above prints once, after the
first plugin row. In `status --json`, a plugin row adds `runs` and
`claudeTrust`.

The rows for plugins from Claude marketplaces now print as
`claude-plugins/<id>`. A `plugins/<name>` row is always a capshelf item.

## Lock version 5

Version 5 is version 4 with one more item kind. It changes no entry. Every
project moves to version 5 once, with or without a plugin.

A version 4 project still works for read-only commands. Each command that
writes a lock refuses with exit 3 and names the migration:

```text
✗ this project's lock is version 4; capshelf add writes lock version 5
  Convert the project and local locks first: capshelf lock migrate (preview it with --dry-run).
```

The step changes only the version number in both locks, in one transaction.
It reads nothing from the data repo and changes no installed file:

```bash
capshelf lock migrate
```

```text
✓ migrated project and local locks to version 5
  converted                  1
  repaired legacy identity   0
  blocked                    0
```

A second run prints `✓ already version 5`.

### The shelves fence

Capshelf 0.13 drops each manifest field that it does not know when it saves
the manifest. It would delete the `plugins` array with no error. To stop
that, a manifest that holds a plugin also holds this key:

```json
"shelves": "plugin items: this project needs a capshelf release that supports plugins"
```

Capshelf 0.13 refuses every manifest with a `shelves` key. Its message
names multi-shelf federation, which is not the real reason. Its advice,
"upgrade capshelf", is correct.

Capshelf adds the fence and removes it with the last plugin. Do not edit it
by hand. `.capshelf/local.json` gets the same fence when it holds a plugin.

## Where the details are

| Question | Page |
|---|---|
| Plugin layout, consent points, and status fields | [Plugins](cli.md#plugins) |
| Plugins from a repository URL | [Whole plugins](cli.md#whole-plugins) |
| Lock version 5 and the migration | [Lock version 5](cli.md#lock-version-5) |
| What a plugin can run, and the threat model | [`docs/security.md`](security.md) |
| Why one folder has one owner | [`docs/architecture.md`](architecture.md) |

## Smaller improvements

- `capshelf show` replaces each terminal control character with a space in
  its text output. An ESC sequence in a repository file cannot clear or forge
  the output that you review. `--json` keeps the exact text.
- A project-scope `promote` that an ignore rule blocks now names the rule,
  its file, and its line. The hint gives the two fixes: remove the rule, or
  move the item to local scope.
- `move` and `share` now accept `--yes`. It gives consent for a plugin that
  `--to project` commits.
- `lock migrate --repin` asks plugin consent the way `update` does.
  `--dry-run` reports the entries under `would ask`.
- A bundle that holds two members with one install folder refuses as a
  whole, before it installs any member.
- The docs now state the one network exception. The startup update check of
  an interactive Homebrew install runs `brew outdated`, and Homebrew can
  update its own data first. `CI`, `--json`, and
  `CAPSHELF_NO_SELF_UPDATE=1` turn the check off.
- The install docs add `brew trust --formula genged/tap/capshelf`. Without
  that entry, `brew upgrade` skips capshelf and says nothing.
- The README was rewritten for a first-time reader.

## Under test

`make smoke-plugins` drives the plugin workflow from source.
`make smoke-older-binary` builds capshelf 0.13 from tag `v0.13.0`. It runs
each 0.13 writer against a plugin project and checks that each one refuses
and changes no file. The CI test lane now checks out full history with tags,
so that suite can find the tag.

The repository pins Bun 1.4.3. `bun run test`, `bun run build`, and
`bun run e2e:run` stop on any other Bun. Set `CAPSHELF_ANY_BUN=1` to run on
another Bun on purpose.

## Breaking changes

- The project lock and the local lock are now version 5. Each command that
  writes a lock refuses a version 4 lock with exit 3 until you run
  `capshelf lock migrate`.
- Capshelf 0.13 refuses a version 5 lock with
  `lock version 5 is newer than this capshelf supports`. A team cannot mix
  0.13 and 0.14 on one project after the migration.
- `.capshelf/remotes.lock.json` is schema version 2 while it holds a plugin
  row. Capshelf 0.13 refuses it. A file with skill rows only stays at
  version 1.
- A write that would give a skill folder a second owner now refuses with
  exit 3. The 0.13 check compared lock keys only. The new check compares
  install folders, so two names that differ only in case or Unicode form
  now conflict.
- `add`, `update`, `move`, `share`, and `lock migrate --repin` can now ask
  plugin consent. A script that installs a plugin with hooks or MCP servers
  needs `--yes`.
- `status` text output prints Claude marketplace plugins as
  `claude-plugins/<id>`, where it printed `plugins/<id>`. The JSON output did
  not change.

## Upgrading

Upgrade the binary on every machine that writes to the project first:

```bash
capshelf self-update
```

Source installs can use the usual build path:

```bash
git pull
make install
```

Then migrate each project once, and commit the project lock:

```bash
capshelf lock migrate --dry-run
capshelf lock migrate
git add .capshelf/capshelf.lock.json
git commit -m "chore(capshelf): migrate lock to version 5"
```

The local lock is gitignored. A clone that has a local lock runs
`capshelf lock migrate` on its own after it pulls the version 5 project lock.

The bundled `capshelf` skill changed. After the migration, update it once in
each project that tracks it:

```bash
capshelf status skills/capshelf
capshelf update skills/capshelf
```

A project with no plugin needs nothing else. Its manifest gets no fence.
