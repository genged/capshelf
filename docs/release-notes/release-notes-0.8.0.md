Capshelf 0.8 fixes items that reported `up-to-date` forever while `update`,
`apply`, and `revert` all refused them. An item's identity is now the tree it was
pinned to in the data repo, rather than a hash of that repo's working copy, so
checkout filters, `core.autocrlf`, index bits, and sparse checkouts can no
longer change what a lock means. This is lock version 4: run `capshelf lock
migrate` once per project, and note that Git 2.40.0 is now the minimum. Full
details in `docs/whats-new-0.8.md`.

## Breaking changes

- **Run `capshelf lock migrate` once in every project.**

  0.8 writes a new lock format, version 4. Capshelf 0.7 and older cannot read
  it and refuse rather than guess, so order matters: upgrade capshelf
  everywhere, including CI, before anyone commits a migrated lock. Until a
  project migrates, `status`, `ls`, `show`, and `apply` keep working, and any
  command that writes the lock stops and tells you to migrate. The upgrade is
  one-way.

- **Capshelf now needs Git 2.40.0 or newer.**

  It has to read a file's Git attributes as of a particular commit, which
  earlier versions of `git` cannot do. With an older `git` on your machine,
  capshelf exits 7 and changes nothing.

- **Items are refused if the data repo runs them through `git-lfs` or
  `git-crypt`.**

  Those tools do not put your file in the repository. They put a stand-in — a
  pointer file for `git-lfs`, ciphertext for `git-crypt` — and restore the real
  bytes only when the tool runs during checkout. Capshelf gives each project
  exactly what the commit holds, so it would hand them the stand-in. It now
  refuses at the point where it would record the pin.

  The refusal is the same on every machine, including one where the tool is
  installed and working, because capshelf reads the declaration from the data
  repo's commit rather than from your local setup. To share a secret, commit it
  already encrypted — with `sops` or `age`, and no filter attribute.

- **Changing a file's executable bit now counts as a change.**

  Before 0.8 the mode sat outside an item's identity, so `chmod +x` in the data
  repo went unnoticed. It now shows as an available update in every project
  that tracks the item.

- **Your project's `.gitignore` no longer changes what capshelf reports.**

  Capshelf used to let the consuming project's Git decide whether an installed
  file had drifted, so adding an ignore rule could change an item's status
  without the file changing. Drift is now measured against the bytes on disk.
  Project Git still decides what you may publish; it no longer decides what an
  item is.

## Enhancements

- Add `capshelf lock migrate`, the only path to version 4: one transaction across the project and local locks, a legacy-hash audit that reports what it repaired, every blocker listed in one pass, plus `--repin`, `--remove-item`, `--dry-run`, and `--json`.
- Materialize `add` from the data repo commit's blobs, exactly as `apply` does, so the two routes cannot disagree about an item's content.
- Name the kind of every install difference — content edit, line endings, encoding, `$Id$`, mode, filter artifact — on the consent prompt, without letting the classification suppress it.
- Report `pin`, `sourceState`, and `installation` as independent axes in `status --json`, plus `installDifferences` and `filteredPaths`; the existing `state` field still carries the derived headline.
- Prove `promote` publishes what the project holds by comparing the project snapshot against the tree the data repo commit produced, inside the transaction, so a `pre-commit` hook or clean filter that rewrote the content unwinds the promotion.

## Bug fixes

- Install and update items from a data repo that normalizes line endings with `core.autocrlf`, `text` attributes, or `eol=crlf`, and deliver what Git stores — the same bytes every clone of that repository produces.
- Render `status --diff` outside your machine's own Git configuration, so it no longer prints nothing for the line-ending difference being investigated.
- Repair an unprovable pin with `capshelf update`, while `apply` and `revert` keep refusing a target their locked commit cannot supply.
- Stop one wedged item from aborting a whole-project `update`; the failing item is reported and every healthy one is still written.
- Run the data repo's own commit hooks on every `promote` commit path; the mechanism no longer depends on whether a Codex marketplace is configured, so a secret scanner or a commit-message check applies to the same command in every data repo.
