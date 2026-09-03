Capshelf 0.11.0 added interactive pickers for setup, installation, sharing,
and promotion. It also added an inline publication preview and strengthened
checks for terminal input, hidden Git state, and changes to picker inputs
after selection. Full examples are in
[What's new in capshelf 0.11](../whats-new-0.11.md).

- Added the shelf picker to `init` and to `add` with no item.
- Added project scanning to `share` with no item. It found unmanaged config,
  skills, Pi extensions, and subagents.
- Added the tracked-item picker to `promote` with no item. `Ctrl-V` previewed
  the exact publication candidate before a commit.
- Rechecked selected picker inputs before each write. A stale row failed
  without blocking successful rows.
- Detected Git index flags that hid canonical source changes from `git status`.
- Summarized binary diffs instead of printing raw bytes. Added specific
  remedies to symlink refusals.
- Fixed no-op fragment promotion, fragment conflict attribution, and legacy
  lock checks during `share`.
- Compatibility: changed terminal-based `init` to open the picker. Use
  `--no-pick` when automation must not prompt. Piped and JSON runs do not
  prompt.
- Upgrade: version 4 locks stayed compatible. No migration was required.
  Projects that track the bundled skill must run
  `capshelf update skills/capshelf` after the upgrade.
