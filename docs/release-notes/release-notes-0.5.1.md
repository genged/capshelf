Capshelf 0.5.1 fixes reconciliation and recovery guidance for clone-local
skills. Existing projects and data repos require no migration.

- Verify clone-local writes by hashing the materialized directory, fixing failures after `apply --local`, `update --local`, and `revert --local`.
- Preserve `--local` in stale-promote recovery guidance and warn users to copy local edits before updating.
