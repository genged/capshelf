Capshelf 0.14.0 added Claude Code plugins as a new item kind. A
`plugins/<name>` item copies a whole plugin directory into the folder that a
skill uses, from the shelf or from a repository URL. Capshelf listed the hooks
and the MCP servers that a plugin runs, and asked before it put them where
Claude Code runs them. The lock moved to version 5, so each project must
migrate once. Full examples are in
[What's new in capshelf 0.14](../whats-new-0.14.md).

- Added the `plugins` copy-directory kind. It had the full skill lifecycle in
  project scope and local scope, and bundles could include it.
- Installed a plugin into the skill folder of its name. Claude Code loads it
  as `<name>@skills-dir` in a trusted workspace. Codex sees the skills only.
- Listed each hook and each MCP server from the pinned tree. Monitors, LSP
  servers, unknown manifest keys, and unreadable declarations were reported
  as `unknown`.
- Asked plugin consent at install, at a pin move that adds an entry, and at
  a write to project scope. With no terminal, `--yes` is the only answer.
- Installed a whole plugin with `capshelf add <url> --path <plugin-dir>`.
  `--list` and the picker read plugin catalogs and grouped skills under their
  plugins.
- Refused a write that would give one skill folder a second owner. The check
  compares folders with case and Unicode folding.
- Reported in `status` the hooks and MCP servers each plugin runs, and the
  Claude Code workspace trust. Claude marketplace rows now print as
  `claude-plugins/<id>`.
- Stripped terminal control characters from `capshelf show` text output.
  Named the ignore rule that blocks a project-scope `promote`.
- Compatibility: the project and local locks are version 5. Each command
  that writes a lock refuses a version 4 lock with exit 3. Capshelf 0.13
  refuses a version 5 lock, a manifest that holds a plugin, and a
  `remotes.lock.json` that holds a plugin row.
- Upgrade: upgrade every machine that writes to the project first. Then run
  `capshelf lock migrate` once in each project and commit the project lock.
  Projects that track the bundled skill must then run
  `capshelf update skills/capshelf`.
