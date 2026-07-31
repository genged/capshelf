Capshelf 0.5 adds project-local Pi extensions, reports skills installed in
user-level Claude and Codex directories, and tightens CLI, write, and path
safety. Existing projects and data repos require no migration.

- Manage Pi extensions through the normal `add`, `status`, `update`, `promote`, `revert`, and `rm` lifecycle.
- Include user-level runtime skills in `ls` and `status` without adopting or modifying them.
- Run project commands from subdirectories and use the grouped `capshelf data` commands.
- Read settings and MCP inputs as JSONC and reject conflicting managed fragments.
- Return structured `--json` errors with documented exit codes.
- Use atomic writes, validated install destinations, and consistent content hashing.
