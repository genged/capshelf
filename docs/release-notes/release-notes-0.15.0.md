Capshelf 0.15.0 changed the default scope of `capshelf share` for a skill or
a plugin that project Git already tracks. Such a share refused with exit 3 in
0.14, because `.git/info/exclude` cannot hide a tracked file. It now goes to
project scope. Full examples are in
[What's new in capshelf 0.15](../whats-new-0.15.md).

- Shared a skill or a plugin to project scope when `--to` is absent and
  project Git tracks its install path. The output names the tracked path.
- Used the same default in the share picker, so the picker no longer offers
  a share that fails.
- Kept the refusal of an explicit `--to local` for a tracked skill. Remote
  and skills.sh adopts stay in local scope.
- Compatibility: no lock, manifest, or data repo change. The lock stays at
  version 5.
- Upgrade: projects that track the bundled skill must run
  `capshelf update skills/capshelf`.
