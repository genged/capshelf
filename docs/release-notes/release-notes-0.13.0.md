Capshelf 0.13.0 added remote skills: `capshelf add <url>` installs a skill
from any Git repository, and `capshelf share <item> --adopt` moves one into
your shelf. The record is gitignored, so a teammate who clones the project
gets nothing until you adopt it. Two commands reach the network that did not
before, and every other command stays offline. Status reports also got much
faster. Full examples are in
[What's new in capshelf 0.13](../whats-new-0.13.md).

- Added `capshelf add <url>`. It printed the repository, the commit, the
  subpath, the file list, and the license finding, and then asked once.
  `--as`, `--ref`, `--path`, and `--list` shaped the install.
- Recorded each remote skill in `.capshelf/remotes.lock.json`, schema version
  1, which is gitignored. The install is local scope and the project lock is
  untouched.
- Added `capshelf status --check-upstream`. It fetched every tracked
  repository and reported which pins moved. It also re-created a missing
  clone cache.
- Reported remote skills in their own `status` group, with the upstream, the
  ref, the pinned commit, and when it was last checked.
- Moved a remote pin with `capshelf update <item>`, offline, from the cache.
  A bare `capshelf update` moved no remote pin and listed the rows it left
  alone.
- Added `capshelf share <item> --adopt`. It vendored the installed bytes into
  the shelf, recorded `upstream`, `upstreamCommit`, and `upstreamPath` in the
  item's `.capshelf.yml`, and released the previous owner. It also adopted a
  skill that `skills.sh` manages.
- Refused a remote skill in `promote`, `move`, `keep-local`, `revert`, and a
  `share` without `--adopt`. Each refusal named the adopt.
- Removed a remote skill and its record with `capshelf rm <item>`.
- Refused a repository URL that carried a credential, and stripped control
  characters from repository-controlled text in the consent prompt.
- Cut the Git work a status report does. `capshelf status` in a project with
  20 settings fragments took 289 ms instead of 1588 ms. `apply`, `update`, and
  `add` reuse reads the same way, within one command.
- Refused an unreadable pinned fragment source before writing any output or
  project metadata. The error names the canonical path and the commit.
- Fixed a dropped second item in `capshelf update <a> <b>` when two items
  shared a name, a missing locked endpoint in `status --diff` for a remote
  skill, and discarded merge fields in `update --merge`.
- Compatibility: `capshelf add <something>/<name>` now exits 3 when the first
  segment is not an item kind, where it exited 1. `capshelf share` now exits 3
  instead of 6 when a project has no data-repo binding and the share also hits
  an earlier refusal. `status --strict` exits 4 on a remote skill with no
  clone cache on this machine, or one that left its upstream repository.
- Upgrade: version 4 locks stayed compatible. No migration was required.
  Projects that track the bundled skill must run
  `capshelf update skills/capshelf` after the upgrade. The first
  `capshelf add <url>` in a project appends `remotes.lock.json` to the
  committed `.capshelf/.gitignore`. Review and commit that line.
