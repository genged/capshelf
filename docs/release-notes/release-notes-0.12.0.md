Capshelf 0.12.0 added a read-only web dashboard for every capshelf project on
the machine, plus the project registry that finds them. It also added a
shadow warning for Pi project skills, and it removed the deprecated
`promote --merge` option. Full examples are in
[What's new in capshelf 0.12](../whats-new-0.12.md).

- Added `capshelf ui`. It served the status of every registered project on
  127.0.0.1, behind a token in the printed URL, and it wrote no file.
- Showed each item's state, its commands, and the diff behind that state,
  computed by the functions `status` runs. External skills, Claude plugins,
  user-level skills, and shadows appeared as read-only rows.
- Added the project registry at `$XDG_CONFIG_HOME/capshelf/projects.json`.
  `init` and `ui` registered the project. A registry failure warned and did
  not fail the command.
- Warned when a `.pi/skills/<name>` entry hid a managed skill. The warning is
  strict, so `status --strict` exits 4 while the shadow exists.
- Worded a Codex user-level skill clash as `same name as`, with no warning,
  because Codex offers both skills.
- Fixed an installed diff that hid a project-only file when the item was up to
  date. Fixed leaked `.capshelf-materialize-*` directories after a busy
  cleanup.
- Fixed `make install` on macOS. An in-place copy kept the old inode, and the
  cached code-signature verdict made the kernel kill every run.
- Compatibility: removed `promote --merge`. The command now exits 1 with
  `unknown option '--merge'`. Use `update <item> --merge`, review the result,
  then run a normal `promote`.
- Upgrade: version 4 locks stayed compatible. No migration was required.
  Projects that track the bundled skill must run
  `capshelf update skills/capshelf` after the upgrade. Run `capshelf ui` once
  in each older project to register it for the dashboard.
