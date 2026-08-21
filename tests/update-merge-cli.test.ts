import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("update --merge", () => {
  test(
    "merges disjoint changes into the installed copy and pins upstream",
    async () => {
      const project = await tempRepo("capshelf-update-merge-project-");
      const dataRepo = await tempRepo("capshelf-update-merge-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "base\nlocal line\nupstream line\n");
      await writeFile(
        join(dataRepo, "skills", "hello", "other.md"),
        "upstream line\n",
      );
      await commitAll(dataRepo, "base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
      const upstream = join(dataRepo, "skills", "hello", "SKILL.md");
      await writeFile(installed, "base\nlocal edit\nupstream line\n");
      await writeFile(
        join(dataRepo, "skills", "hello", "other.md"),
        "upstream edit\n",
      );
      await commitAll(dataRepo, "upstream");
      const dataBefore = await readFile(upstream);

      const result = await run(["update", "skills/hello", "--merge", "--json"]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const report = JSON.parse(result.stdout.toString());
      expect(report.items[0].action).toBe("merged");
      expect(report.items[0].merged).toBe(true);
      expect(await file(installed).text()).toBe(
        "base\nlocal edit\nupstream line\n",
      );
      expect(
        await file(
          join(project, ".agents", "skills", "hello", "other.md"),
        ).text(),
      ).toBe("upstream edit\n");
      expect(await readFile(upstream)).toEqual(dataBefore);

      const status = await run([
        "status",
        "skills/hello",
        "--diff-view",
        "installed",
        "--json",
      ]);
      const statusReport = JSON.parse(status.stdout.toString());
      expect(statusReport.diffs[0].view).toBe("installed");
      expect(statusReport.diffs[0].from.role).toBe("locked");
      expect(statusReport.diffs[0].to.role).toBe("installed");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "reports conflicts without changing installed content or the lock",
    async () => {
      const project = await tempRepo("capshelf-update-conflict-project-");
      const dataRepo = await tempRepo("capshelf-update-conflict-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "base\n");
      await commitAll(dataRepo, "base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
      const upstream = join(dataRepo, "skills", "hello", "SKILL.md");
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      await writeFile(installed, "local\n");
      await writeFile(upstream, "upstream\n");
      await commitAll(dataRepo, "upstream");
      const installedBefore = await readFile(installed);
      const lockBefore = await readFile(lockPath);

      const result = await run(["update", "skills/hello", "--merge"]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("SKILL.md");
      expect(await readFile(installed)).toEqual(installedBefore);
      expect(await readFile(lockPath)).toEqual(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
