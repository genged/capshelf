# What's new in capshelf 0.12

## Summary

- `capshelf ui` serves a read-only dashboard on localhost. It shows every
  registered project, the state of each item, the diff behind that state, and
  the command to run.
- `capshelf init` and `capshelf ui` add the project to a machine-wide
  registry. The dashboard lists the projects in that file.
- `status` now warns when a `.pi/skills` copy hides a managed skill.
  `status --strict` exits 4 while the shadow exists.
- `promote --merge` is removed. Reconcile with `update <item> --merge`, review
  the result, then run a normal `promote`.
- The lock stays at version 4. Upgrade the binary, then update the bundled
  `capshelf` skill in each project.

Capshelf 0.12 gives the same facts a second face. The CLI answers for one
project at a time. The dashboard shows every project on the machine at once,
and it computes each row with the function `status` uses:

```text
~/.config/capshelf/projects.json
     |
     +-- ~/code/app-a --+
     +-- ~/code/app-b --+--> capshelf ui --> http://127.0.0.1:<port>/?t=<token>
     +-- ~/code/app-c --+
```

The dashboard writes nothing. It shows the command for each item, and you run
that command in a terminal.

## Do I need to do anything?

| If you | Then |
|---|---|
| want the dashboard | Run `capshelf ui` in a project |
| have projects from an earlier version | Run `capshelf ui` once in each, or add each path to the registry file |
| use `promote --merge` in a script | Use `update <item> --merge`, then `promote` |
| keep a `.pi/skills/<name>` copy of a managed skill | Remove the copy, or expect `status --strict` to exit 4 |
| run `init` in a sandbox | Permit one write to `$XDG_CONFIG_HOME/capshelf/projects.json` |
| have projects on capshelf 0.11 | No lock migration is necessary |
| track `skills/capshelf` | Run `capshelf update skills/capshelf` after the binary upgrade |

## See every project in one dashboard

Start the server from any project:

```bash
cd ~/code/my-app
capshelf ui
```

The command prints the URL, opens a browser, and serves until Ctrl-C:

```text
capshelf ui is serving at http://127.0.0.1:40399/?t=7cf191b76a726b4af993de64073177d7
  registry: ~/.config/capshelf/projects.json
  registered this project: ~/code/my-app
  press Ctrl-C to stop
```

The last line changes to `this project:` when the project is already in the
registry. Ctrl-C stops the server and the command exits 0.

Three options control the run:

```bash
capshelf ui --no-open     # print the URL, do not open a browser
capshelf ui --port 4917   # listen on a fixed port instead of a free one
capshelf ui --json        # print one JSON line, then serve
```

`--json` prints the details before it serves:

```json
{"url":"http://127.0.0.1:36407/?t=c35211092ce70c87924a612064d77408","port":36407,"registry":"/home/mg/.config/capshelf/projects.json","project":"/home/mg/code/my-app","registered":false}
```

`project` is the project the command ran inside, or `null`. `registered` is
`true` only when this run added the project to the registry.

## Projects register themselves

The dashboard needs a list of projects, because no other command finds them on
a machine. `init` writes that list:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
```

One line of the setup report names the file:

```text
  registered for capshelf ui: ~/.config/capshelf/projects.json
```

The file holds paths and dates only:

```json
{
  "version": 1,
  "projects": [
    { "path": "/home/mg/code/my-app", "registeredAt": "2026-09-07T20:50:40.932Z" }
  ]
}
```

`$XDG_CONFIG_HOME` selects the directory. `~/.config` is the default when the
variable is unset or empty. A registry failure prints a warning and does not
fail the init. `init --json` reports `registry.path`, and `registry.error`
when the write failed.

`capshelf ui` adds the project it runs inside. For a project that predates
0.12, run `capshelf ui` in it once:

```bash
cd ~/code/older-app
capshelf ui --no-open
```

No command removes an entry. Edit the file to remove a project that moved. A
registered path with no manifest stays in the list and is marked missing.

## What the dashboard shows

- **Projects.** The left column lists every registered project, sorted by the
  number of items that need attention. The selected project lists its items
  under one heading per kind.
- **Items.** The center shows one panel per item, in one group per kind. A
  panel opens in place to the commands that resolve it, each with a copy
  button, then its facts and a summary of its diff. Filter tabs select all
  items, items that need attention, or items that are up to date. A chip row
  selects one kind.
- **Diffs.** The panel summarizes each changed file with its added and removed
  line counts. The Open diff button shows the full diff in a dialog, side by
  side or unified. Three-way has no unified form.
- **External state.** Everything else a harness loads in the project appears
  as a read-only row in the same groups. Such a row has an "External" badge
  and no commands. skills.sh skills sit under Skills. Claude plugins and
  user-level skills form their own groups.
- **Shadows.** An item can be up to date and still hidden from a harness. Its
  badge then carries the warning, such as "Shadowed by a Pi project skill".
- **This machine.** The host name in the top bar opens the description of the
  home directory: each user-level skill, and each user or managed Claude
  plugin.
- **Shelf.** The shelf name opens every item and bundle in the data repo, with
  the picker's search. Until you select an item, the reader shows the shelf's
  head, branch, bound projects, and recent commits.

An item needs attention when `status --strict` would fail on it. Every row is
the row `status --json` prints. Every diff comes from the engine behind
`status --diff`. Every command is printed the way the CLI prints it, and it
runs as printed from the project root.

## The dashboard only reads

The server binds 127.0.0.1, so no other machine can connect to it. The printed
URL carries a random token, and every `/api/` request must carry that token as
a bearer header. The server refuses a request whose `Host` header is not its
own address, serves GET only, sends no CORS headers, and marks every response
`no-store`. It makes no outbound connection.

Command output stays scriptable, so this captures the JSON line only:

```bash
capshelf ui --json --no-open >ui.json
```

## A Pi project skill can hide a managed skill

Pi ranks a project's `.pi/skills/` above its `.agents/skills/`, and it keeps
the first skill it finds for a name. A copy there therefore hides the managed
skill from Pi:

```bash
mkdir -p .pi/skills/security-review
$EDITOR .pi/skills/security-review/SKILL.md
capshelf status skills/security-review
```

```text
project/
  ✓   data/skills/security-review             8d87b8a95ac2  up-to-date
    ⚠ Pi project skill shadows this project skill
      Pi will load .pi/skills/security-review before this project skill.
```

The warning type is `shadowed_by_pi_project_skill` in JSON. The check is by
name, as the personal Claude check is. A `.pi/skills/<name>.md` file counts
too. A `.pi/skills/<name>` symlink that resolves to the managed copy is not a
shadow.

The warning is strict, so a drift gate fails while the copy exists:

```bash
capshelf status --strict   # exit 4
```

Capshelf does not manage `.pi/skills`. Remove the copy, or point it at the
managed skill, to clear the warning.

## Promote after a merge, not with one

`promote --merge` is removed. The reconciliation it performed belongs to
`update`, which keeps the merged result in the project until you review it:

```bash
capshelf update skills/merge-demo --merge     # merge upstream into the project
capshelf status skills/merge-demo --diff      # review the merged result
capshelf promote skills/merge-demo -m "publish the merged edits"
```

`update --merge` pins upstream and publishes nothing. The installed copy holds
the merged result and reports local drift until the `promote` publishes it. A
conflict writes nothing and exits 3.

The old form now fails before any work:

```bash
capshelf promote skills/merge-demo --merge
```

```text
error: unknown option '--merge'
```

The command exits 1. `promote --json` still reports the actions `promoted`,
`already-current`, and `already-upstream`, and `staleOverride: true` when
`--stale-ok` bypassed a stale check. The fields `merged`, `mergeBase`, and
`mergedUpstreamCommit` are gone from `promote`. The command
`update --merge --json` reports them.

## Smaller improvements

- An installed diff now lists a file that exists only in the project, even
  when the item is up to date. `status <item> --diff-view installed` said
  `(no content differences)` before, and the extra file was invisible until
  `update` proposed to remove it.
- Materialization cleanup now retries, so a busy directory no longer leaves a
  `.capshelf-materialize-*` directory beside the item. A cleanup failure now
  reaches the caller instead of passing silently.
- The user-level skill inventory now words each row by harness. A Claude row
  says `shadows`. A Codex row says `same name as …; Codex offers both`,
  because Codex offers both skills and hides neither.
- `make install` now renames the new binary into place. A plain copy kept the
  old inode, and macOS still held the code-signature verdict it cached for the
  previous contents. Every command then died with SIGKILL and printed nothing.
- The README shows the dashboard, and the security page documents the local
  server, the registry file, and the clone that `init` performs. The runtime
  matrix now agrees with the Pi shadow warning: Pi loads `.agents/skills`.

## Under test

A new smoke suite covers the web UI from source: `make smoke-ui`. It checks
four things. `init` registers the project. The server prints its URL and keeps
running. The API answers with the token and refuses without it. SIGTERM stops
the command with exit 0.

The end-to-end suite drives the compiled binary the same way. It proves that
the packaged binary serves the dashboard shell, its embedded assets, and the
status rows, on 127.0.0.1 behind the URL token. A headless fetch stands in for
the browser, so it proves the served bytes and the API, not the rendering.

`bun run lint` now runs Biome, then Oxlint with the anti-slop plugin in
`tools/oxlint/anti-slop/`. A separate CI job runs the same two checks. The
source and the tests also read external JSON, YAML, and TOML through one
config value model. A document is parsed and narrowed, not asserted.

## Breaking changes

- `promote --merge` is no longer accepted. The command exits 1 with
  `unknown option '--merge'`. Use `update <item> --merge`, then `promote`.
- `status --strict` now exits 4 when a `.pi/skills/<name>` entry hides a
  managed skill. A drift gate in such a project fails until the copy goes.
- `init` now writes one file outside the project: the registry at
  `$XDG_CONFIG_HOME/capshelf/projects.json`. A sandbox that forbids the write
  gets a warning, and the init still succeeds.

There is no lock-format change. Capshelf 0.11 and 0.12 use version 4 locks.

## Upgrading

Upgrade the binary:

```bash
capshelf self-update
```

Source installs can use the usual build path:

```bash
git pull
make install
```

No lock migration is necessary. The bundled `capshelf` skill changed, so
update it once in each project that tracks it:

```bash
capshelf status skills/capshelf
capshelf update skills/capshelf
```

Then register the projects that predate 0.12, one run in each:

```bash
capshelf ui --no-open
```
