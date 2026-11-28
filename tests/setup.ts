// Isolate git from the contributor's global config: an `url.<x>.insteadOf`
// rewrite changes a seeded clone's origin and reddens bootstrap tests.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Under `bun test --parallel` the preload runs per file in a reused worker and
// never emits `exit`, so cleanup uses `afterAll`; CAPSHELF_TEST_TMP_PARENT
// stops a worker that keeps its env from nesting run dirs inside one about to
// be removed.
const parentTmp = process.env.CAPSHELF_TEST_TMP_PARENT ?? tmpdir();
process.env.CAPSHELF_TEST_TMP_PARENT = parentTmp;
const runDir = realpathSync(mkdtempSync(join(parentTmp, "capshelf-test-run-")));
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = runDir;
afterAll(() => {
  if (
    process.env.CAPSHELF_KEEP_TEST_TMP === "1" ||
    process.env.KEEP_E2E_TMP === "1"
  ) {
    process.stderr.write(`kept test files: ${runDir}\n`);
    return;
  }
  rmSync(runDir, { recursive: true, force: true });
});

// Point the registry at a throwaway dir so tests never register projects on the
// contributor's machine.
process.env.XDG_CONFIG_HOME = mkdtempSync(
  join(tmpdir(), "capshelf-test-config-"),
);

// Status reads Claude Code transcripts and saves a cache, so tests must see
// neither the contributor's transcripts nor their cache folder.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(
  join(tmpdir(), "capshelf-test-claude-"),
);
process.env.XDG_CACHE_HOME = mkdtempSync(
  join(tmpdir(), "capshelf-test-cache-"),
);
