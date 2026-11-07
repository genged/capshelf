import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

/**
 * Named `capshelf promote <item>` must refuse when git hides a canonical
 * source of the item, the same as the interactive picker does.
 */

const HIDDEN = "hello HIDDEN\n";
const LOCAL = "hello LOCAL\n";

async function driftedProject(): Promise<{
  project: string;
  dataRepo: string;
  run: ReturnType<typeof runInProcess>;
  canonical: string;
}> {
  const project = await tempRepo("capshelf-unwatched-project-");
  const dataRepo = await baselineRepo("capshelf-unwatched-data-");
  await addSkill(dataRepo, "hello", "hello\n");
  await commitAll(dataRepo, "add hello");
  const run = runInProcess(project);
  expect(
    (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
  ).toBe(0);
  expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
  await writeFile(join(project, ".claude/skills/hello/SKILL.md"), LOCAL);
  return {
    project,
    dataRepo,
    run,
    canonical: join(dataRepo, "skills/hello/SKILL.md"),
  };
}

describe("named promote with git-hidden data-repo paths", () => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    test(
      `${flag} is refused and the hidden bytes stay`,
      async () => {
        const { dataRepo, run, canonical } = await driftedProject();
        await writeFile(canonical, HIDDEN);
        await $`git -C ${dataRepo} update-index ${flag} skills/hello/SKILL.md`.quiet();
        const head = (await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim();

        const result = await run(["promote", "skills/hello", "-m", "x"]);
        expect(result.exitCode).not.toBe(0);
        const err = result.stderr.toString();
        expect(err).toContain("git is not watching");
        expect(err).toContain("skills/hello/SKILL.md");
        expect(await readFile(canonical, "utf-8")).toBe(HIDDEN);
        expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
          head,
        );
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }

  test(
    "without index bits the drifted copy still promotes",
    async () => {
      const { dataRepo, run, canonical } = await driftedProject();
      const result = await run(["promote", "skills/hello", "-m", "x"]);
      expect(result.exitCode).toBe(0);
      expect(await readFile(canonical, "utf-8")).toBe(LOCAL);
      const log = await $`git -C ${dataRepo} log -1 --format=%s`.text();
      expect(log.trim()).toBe("x");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
