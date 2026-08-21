import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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

  test(
    "refuses a skill that skills.sh claimed after capshelf installed it",
    async () => {
      const project = await tempRepo("capshelf-update-merge-external-project-");
      const dataRepo = await tempRepo("capshelf-update-merge-external-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "base\n");
      await commitAll(dataRepo, "base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
      const upstream = join(dataRepo, "skills", "hello", "SKILL.md");
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      await writeFile(
        join(project, "skills-lock.json"),
        `${JSON.stringify({ skills: { hello: { source: "acme/hello" } } })}\n`,
      );
      await writeFile(upstream, "upstream\n");
      await commitAll(dataRepo, "upstream");
      const installedBefore = await readFile(installed);
      const lockBefore = await readFile(lockPath);

      const result = await run(["update", "skills/hello", "--merge"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("not updating skills/hello");
      expect(result.stderr.toString()).toContain(
        "managed by skills.sh (acme/hello)",
      );
      expect(await readFile(installed)).toEqual(installedBefore);
      expect(await readFile(lockPath)).toEqual(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses an upstream path below an ignored local symlink",
    async () => {
      const project = await tempRepo("capshelf-update-merge-symlink-project-");
      const dataRepo = await tempRepo("capshelf-update-merge-symlink-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "base\n");
      await commitAll(dataRepo, "base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello");
      const outside = join(project, "outside");
      const sentinel = join(outside, "file.md");
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      await mkdir(outside);
      await writeFile(sentinel, "outside\n");
      await writeFile(
        join(project, ".gitignore"),
        ".agents/skills/hello/generated\n",
      );
      await symlink(outside, join(installed, "generated"));

      const upstreamDir = join(dataRepo, "skills", "hello", "generated");
      await mkdir(upstreamDir);
      await writeFile(join(upstreamDir, "file.md"), "upstream\n");
      await commitAll(dataRepo, "add generated file");
      const lockBefore = await readFile(lockPath);

      const result = await run(["update", "skills/hello", "--merge"]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain(
        "ignored local path generated collides with selected managed path generated/file.md",
      );
      expect(await file(sentinel).text()).toBe("outside\n");
      expect(await readFile(lockPath)).toEqual(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "dry-run and execution both accept an ignored regular file at a new managed path",
    async () => {
      const project = await tempRepo("capshelf-update-merge-ignored-project-");
      const dataRepo = await tempRepo("capshelf-update-merge-ignored-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hello", "base\n");
      await commitAll(dataRepo, "base");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

      const installed = join(project, ".agents", "skills", "hello");
      await writeFile(
        join(project, ".gitignore"),
        ".agents/skills/hello/generated.txt\n",
      );
      await writeFile(join(installed, "generated.txt"), "ignored local\n");
      await writeFile(
        join(dataRepo, "skills", "hello", "generated.txt"),
        "upstream\n",
      );
      await commitAll(dataRepo, "add generated file");

      const dryRun = await run([
        "update",
        "skills/hello",
        "--merge",
        "--dry-run",
      ]);
      expect(dryRun.exitCode).toBe(0);
      expect(await file(join(installed, "generated.txt")).text()).toBe(
        "ignored local\n",
      );

      const result = await run(["update", "skills/hello", "--merge"]);
      expect(result.exitCode).toBe(0);
      expect(await file(join(installed, "generated.txt")).text()).toBe(
        "upstream\n",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
