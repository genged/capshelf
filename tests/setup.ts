// Test preload (see bunfig.toml). Isolate every git invocation — both the `$`
// calls in tests and the CLI spawns, which inherit process.env — from the
// contributor's machine config. Without this, a global `url.<x>.insteadOf`
// rewrite (corporate HTTPS proxies, SSH-rewrite setups, sandboxed CI) rewrites
// a seeded clone's origin, and capshelf correctly reports a mismatched upstream
// — reddening the bootstrap tests through no fault of the contributor.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every temporary directory of a test file goes under one run directory: the
// fixtures of the tests, and the files of the CLI and Git processes they
// start, which inherit TMPDIR. A full run used to leave about 2,700
// directories and 130,000 files in the temporary directory, which filled the
// inodes of a small machine.
//
// `bun test --parallel` runs this preload once for each test file, in a
// worker that it reuses, and never emits the process `exit` event. A preload
// `afterAll` runs after each file, so it removes the run directory of that
// file. CAPSHELF_KEEP_TEST_TMP=1 keeps the run directory and prints its path.
// So does KEEP_E2E_TMP=1, because an E2E world lives in the run directory and
// that switch promises to keep the world.
//
// A probe with Bun 1.4.3 showed that a reused worker starts the next file with
// the environment reset, so a new run directory goes under the system
// temporary directory. CAPSHELF_TEST_TMP_PARENT guards that: without it, a
// runtime that kept the environment would nest the next run directory inside
// one that is about to be removed.
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

// The registry `init` and `ui` write lives under the XDG config home. Point
// it at a throwaway directory so a test never registers a temporary project
// on the contributor's machine.
process.env.XDG_CONFIG_HOME = mkdtempSync(
  join(tmpdir(), "capshelf-test-config-"),
);
