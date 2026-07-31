Capshelf 0.4 makes shared agent configuration easier to bootstrap, discover,
bundle, and keep in sync across a team. Existing projects and data repos remain
compatible, but the deprecated `promote --create` flag has been removed.

- Initialize a project directly from a remote data-repo URL, or install Capshelf with the checksum-verifying shell script.
- Describe, search, inspect, and relate shelf items with `.capshelf.yml`, `search`, improved `ls`, and improved `show`.
- Install curated bundles with an all-or-nothing preflight and normal per-item locks.
- Share existing settings and MCP values directly from project output files.
- Fast-forward a data-repo clone with `sync-data`, block stale promotes, and detect unreachable lock commits with `status --strict`.
- Reject `:` in item names and replace the removed `promote --create` flow with `capshelf share <item> --to project`.
