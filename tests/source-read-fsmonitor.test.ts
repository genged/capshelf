import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  addSkill,
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  runIn,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { sourceRead } from "../src/git";

/**
 * A read-only command runs no program the data repo names. `core.fsmonitor`
 * names one, and `git status` runs it. The `source-read` profile must turn it
 * off even when the repository's own configuration sets it.
 */

async function armFsmonitor(dataRepo: string): Promise<string> {
  const scriptDir = await tempDir("capshelf-fsmonitor-script-");
  const marker = join(scriptDir, "marker");
  const script = join(scriptDir, "monitor.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
  await chmod(script, 0o755);
  await $`git -C ${dataRepo} config core.fsmonitor ${script}`.quiet();
  return marker;
}

describe("source-read profile: core.fsmonitor", () => {
  test("sourceRead status does not run the configured fsmonitor", async () => {
    const dataRepo = await tempRepo("capshelf-fsmon-data-");
    await addSkill(dataRepo, "hello");
    await commitAll(dataRepo, "hello");
    const marker = await armFsmonitor(dataRepo);

    const result = await sourceRead(dataRepo, [
      "status",
      "--porcelain=v1",
      "-z",
    ]);

    expect(result.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test(
    "capshelf status does not run the configured fsmonitor",
    async () => {
      const project = await tempRepo("capshelf-fsmon-project-");
      const dataRepo = await tempRepo("capshelf-fsmon-data-");
      await addSkill(dataRepo, "hello");
      await commitAll(dataRepo, "hello");
      const run = runInProcess(project);
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const before = runIn(project)(["status", "--json"]);
      const marker = await armFsmonitor(dataRepo);
      const after = runIn(project)(["status", "--json"]);

      expect(after.exitCode).toBe(before.exitCode);
      expect(after.stdout.toString()).toBe(before.stdout.toString());
      expect(existsSync(marker)).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
