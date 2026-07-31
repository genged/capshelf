# What's new in capshelf 0.5.1

Capshelf 0.5.1 fixes reconciliation and recovery guidance for clone-local
skills. Existing projects and data repos need no migration.

## Fix clone-local skill reconciliation

In 0.5.0, project Git excludes could make post-write verification see an empty
local-scope skill. `apply --local`, `update --local`, or `revert --local` could
therefore fail after writing the new files. Verification now hashes the
materialized directory directly.

## Preserve clone-local recovery steps

Stale-promote recovery guidance now preserves `--local` for clone-local skills
and warns you to copy the current edit before running `update --local`. Those
skills are excluded from the project Git repository, so its diff cannot recover
an overwritten edit.

## Upgrading

```bash
capshelf self-update        # Homebrew installs
# or re-run the install script / git pull && make install for source installs
```

There are no manifest, lockfile, or data-repo migrations.
