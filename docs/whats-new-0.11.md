# What's new in capshelf 0.11

## Summary

- `capshelf init` now offers the shelf after setup. Run `capshelf add` later
  to open the same picker.
- `capshelf share` now finds unmanaged config and untracked project items.
  Mark the rows that you want to share.
- `capshelf promote` now lists tracked items. Press `Ctrl-V` to preview the
  exact candidate before publication.
- Picker actions recheck their inputs after the prompt closes. Stale rows fail
  without blocking successful rows.
- The lock stays at version 4. Upgrade the binary, then update the bundled
  `capshelf` skill in each project.

Capshelf 0.11 adds one interactive picker to four commands. The picker covers
the complete config loop:

```text
data repo items  -- init or add -->  project
project config   -- share ------->  data repo
project edits    -- promote ----->  data repo
                         |
                         +-- Ctrl-V previews the publication candidate
```

The named command forms still support scripts and agents. The picker gives a
human the same operations without requiring an item ref first.

## Do I need to do anything?

| If you | Then |
|---|---|
| run `init` in a terminal and want no prompt | Add `--no-pick` |
| run `init --json` or pipe its output | Nothing. These forms do not prompt |
| call `add`, `share`, or `promote` without an item | Use a terminal, or supply an item for a non-interactive run |
| have projects on capshelf 0.10 | No lock migration is necessary |
| track `skills/capshelf` | Run `capshelf update skills/capshelf` after the binary upgrade |

## Pick items during setup or later

Initialize a project as usual:

```bash
cd ~/code/my-app
capshelf init --data ~/code/agent-config
```

After setup, `init` opens the shelf. Type a query, press `Tab` to mark rows,
and press `Enter` to install them. Press `Esc` to finish without an install.
The project stays initialized in both cases.

Run this command to open the shelf again:

```bash
capshelf add
```

The `All` tab groups rows by item type. Use Left and Right to select one type.
Use Up and Down to move through rows.

The filter uses fuzzy subsequences. For example, `secrev` finds
`skills/security-review`. A lowercase query ignores case. A query with a
capital letter is case-sensitive.

The picker searches item refs, tags, and descriptions. It does not read item
content. Use `capshelf search` when you must search content or produce
scriptable results.

Named installs work as before:

```bash
capshelf add skills/security-review
capshelf add bundles/go-backend
```

A picker selection is a set of independent choices. If one item fails, the
other marked items stay installed. The failure names a command for that item.
This rule differs from a bundle, where one failed member refuses the bundle.

Use `--no-pick` when an interactive automation tool runs `init` in a terminal:

```bash
capshelf init --data ~/code/agent-config --no-pick
```

A run through pipes also skips the `init` picker and exits successfully.
`init --json` never prompts.

## Share what is already in a project

Run `share` without an item to scan the current project:

```bash
capshelf share
```

The picker can offer these sources:

- unmanaged settings from `.claude/settings.json`.
- unmanaged MCP servers from `.mcp.json` and `.codex/config.toml`.
- unmanaged Codex config from `.codex/config.toml`.
- untracked skills and Pi extensions.
- untracked Claude and Codex subagents.

For config, each row is a value path that the named `--pick` form accepts.
The detail column shows only the value shape. It does not show the value.

Mark related settings paths, then supply one item name after the picker
closes. Capshelf prints the equivalent non-interactive command:

```bash
capshelf share settings/team-permissions \
  --pick permissions.allow \
  --pick permissions.deny
```

An MCP server uses its server name as its item name. If you mark its Claude
and Codex rows, one item covers both targets. If you mark one row, the
equivalent command includes `--target claude` or `--target codex`.

Untracked copy items keep the defaults of named `share`. Skills use local
scope. Pi extensions and subagents use project scope.

For example, create a local skill and share it from the picker:

```bash
mkdir -p .agents/skills/release-review
$EDITOR .agents/skills/release-review/SKILL.md
capshelf share
```

The picker shows invalid or conflicting sources as disabled rows. Focus a
disabled row to read the reason. `Tab` cannot mark it.

## Preview and promote several changes

Edit a tracked item, then open the promote picker:

```bash
$EDITOR "$(capshelf get-path skills/security-review)/SKILL.md"
capshelf promote -m "tighten the release review"
```

The picker lists all tracked data items. A row with a publishable change can
be marked. A clean row stays visible and says `nothing to promote`.

Press `Ctrl-V` on the focused row to open its diff. The diff compares the
item at data-repo `HEAD` with the candidate that `promote` would publish.
This also works for fragments and subagents.

Use Up, Down, Page Up, or Page Down to scroll. Press `q` or `Ctrl-V` to close
the diff. Then press `Tab` and `Enter` to publish the marked rows.

Capshelf records the preview inputs. Before it commits, it compares the base
and candidate again. If either changed, that item fails and asks for a new
preview. Other marked items can still succeed.

Each successful item produces the same commit as a named `promote`. The final
output prints one summary and one data-repo push reminder.

## Picker safety and terminal behavior

The picker needs terminals on stdin and stderr. It also needs a usable `TERM`.
An empty `TERM` or `TERM=dumb` causes a refusal instead of a damaged frame.

The frame writes to stderr. Command results stay on stdout, so this still
captures only the result:

```bash
capshelf add >capshelf-add.log
```

Capshelf replaces terminal control characters in catalog text before it draws
the frame. Matching and highlighting count Unicode code points, so emoji,
Cyrillic, and CJK text do not split into invalid character halves.

Rows, menus, queries, and legends fit the detected terminal width. A long row
cannot wrap and move the frame on each redraw.

Every picker reloads the project and data repo after the prompt closes. If a
selected value or file changed during the prompt, only that row fails.

## Smaller improvements

- A clean fragment `promote` now reports `already-current`. It no longer
  claims that upstream changed when the fragment is unchanged.
- `share` now checks for a legacy lock before it commits to the data repo.
  A refused share leaves no stray commit to undo.
- Fragment conflict messages now name the correct contributing fragment when
  config path words overlap.
- The promote picker detects `--assume-unchanged` and `--skip-worktree` index
  flags. Affected rows say that Git is not watching the path.
- Printed retry and equivalent commands now quote unsafe arguments. The
  commands can contain spaces, quotes, or shell metacharacters safely.
- `status --diff` and promote previews now summarize binary changes as
  `Binary files differ`. They do not print raw bytes to the terminal.
- Symlink refusals now give a remedy for the walker that found the link. For
  example, a generated dependency can be removed or ignored inside an item.
- A first fragment `add` no longer suggests `status --diff` when that command
  has no tracked row to show.
- The README now contains a recorded demonstration of the two-project update
  and promote loop.

## Under test

The packaged-binary suite now drives the picker through a pseudo-terminal. It
checks fuzzy matching, type tabs, disabled rows, narrow terminals, and Unicode
queries. It also checks the `Ctrl-V` promote preview.

The end-to-end suite now covers the complete `codex-config` and subagent
lifecycles. New scenarios also protect `update --merge` and the limits on what
`promote` can overwrite.

## Breaking changes

- `capshelf init` now opens the shelf when stdin and stderr are usable
  terminals. Add `--no-pick` if a terminal-based script must never pause.
  Piped and `--json` runs do not prompt.
- Item and bundle names now reject C1 control characters. Normal names are
  unaffected. Rename any data-repo entry that contains U+0080 through U+009F.

There is no lock-format change. Capshelf 0.10 and 0.11 use version 4 locks.

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
