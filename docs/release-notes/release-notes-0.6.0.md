Capshelf 0.6 adds cross-runtime subagents, plugin marketplace tooling, declared
runtime needs, clean stale-promote merging, and clone-local Pi extensions. It
writes lockfile version 3; upgrade every contributor and CI runner before
committing a lock written by 0.6.

- Manage one logical subagent with Claude Markdown and Codex TOML targets.
- Build, validate, sync, and package independent Claude/Cowork and Codex plugin catalogs from canonical skills.
- Declare expected network hosts, environment variables, and commands in `.capshelf.yml`, with advisory Runfree policy checks.
- Resolve supported stale promotes with an isolated three-way merge via `promote --merge`.
- Use project or clone-local scope for Pi extensions and compatible bundles.
- Reduce status-time blob loading, improve removal diagnostics, make the exported CLI entry point reentrant, and run tests in parallel.
- Upgrade before project writes: Capshelf 0.5 cannot read a lockfile after 0.6 saves it as version 3.
