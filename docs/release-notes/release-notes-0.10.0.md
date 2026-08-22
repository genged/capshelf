Capshelf 0.10 moves the merge out of `promote` and into `update`.
`capshelf update <item> --merge` merges your edit with the newer upstream
version. It writes the result to the installed copy, and moves the lock to the
upstream commit. It changes nothing in the data repo. You review the result,
then you publish it with an ordinary `promote`. `status --diff` supports that
review: it shows locked to installed, and locked to upstream. The diff also
shows changes that 0.9 dropped, such as an added empty file or a changed file
mode. This release adds the first end-to-end suite that drives the compiled
binary, and it fixes the three defects that the suite found. The lock format
stays at version 4, so 0.9 and 0.10 read the same locks and need no migration.
For full details, see `docs/whats-new-0.10.md`.

- Added `update <item> --merge`. It is a three-way merge from the locked base into the installed copy. It supports skills and Pi extensions, in project scope and local scope. It takes one explicit item, refuses `--yes`, and needs a clean data repo and a base that capshelf can prove. A conflict writes nothing.
- Deprecated `promote --merge`, which merged and published in one step. It still works, and prints the replacement route on stderr. A `--json` call does not change.
- Added the second comparison to `status --diff`. It now shows locked to installed, and locked to upstream. Added `--diff-view installed|upstream|all`, which also turns on `--diff`. Added `view`, `from`, and `to` to each `--json` diff entry. A comparison that capshelf cannot read has `text: null` and an `unavailableReason`.
- Added existence and the executable bit to each side of the diff. An added empty file, a deleted file, and a changed file mode are now visible. 0.9 named these changes as drift in the row, then printed nothing.
- Added a collision check between destination paths and kept paths, before capshelf writes a reconciled tree. The check uses the folding that the destination performs. `update --merge` now refuses a `skills.sh`-owned skill before it plans, and again before it saves.
- Stopped a missing data-repo clone from blocking every command. `status` gives the report that it can, and exits 0. Commands that write exit 6 with the clone, bind, and retry steps. 0.9 exited 4, and named a repair in a directory that did not exist.
- Changed `apply` to write all fragment outputs as one unit, as `update`, `rm`, and `revert` do. A target that failed used to leave the earlier targets on disk.
- Named every choice in the stale-promote refusal, in the order that you run them. Pointed the "review this first" messages in `apply`, `rm`, `revert`, and `update` at `status <item> --diff-view installed`.
- Added an end-to-end suite that drives the compiled binary: `bun run e2e`, or `bun run e2e:run` against `CAPSHELF_E2E_BIN`. Added a release gate that needs a green Test run for the exact commit, and that refuses a tag that moved. Declared the Bun version one time, in `package.json#packageManager`.

## Compatibility

- `status --diff` prints two comparisons, and new header text. A script that reads the human output for `diff data/<kind>/<name>` or `+++ <file> (current)` finds no match. `--diff-view installed` gives the 0.9 comparison, but not the 0.9 headers.
- A `--json` diff entry is no longer unique for each path. Use `path` and `view` together as the key.
- A merge is not published until you promote it. The item reads as drifted until then, and `capshelf status --strict` exits 4.
- `make check` no longer runs `check-bun-pin` or `check-e2e-bin`. Both scripts are gone, and their invariants are now enforced where they are used.
- There is no lock migration. Run `capshelf update skills/capshelf` one time in each project, to take the new bundled skill.
