import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addSkill, commitAll, runInProcess, tempRepo } from "./cli-fixtures";

describe("standalone add convergence", () => {
  test("already-installed add is byte- and lock-stable even with drift and newer upstream", async () => {
    const project = await tempRepo("capshelf-add-idempotent-project-");
    const dataRepo = await tempRepo("capshelf-add-idempotent-data-");
    const run = runInProcess(project);
    const skill = await addSkill(dataRepo, "hello", "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const originalLock = await file(lockPath).text();
    await writeFile(installed, "local edit\n");
    await writeFile(join(skill, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");
    await writeFile(join(skill, "SKILL.md"), "dirty v3\n");
    const manifestBefore = await file(manifestPath).text();
    const lockBefore = await file(lockPath).text();

    const addedAgain = await run(["add", "skills/hello", "--json"]);
    expect(addedAgain.exitCode).toBe(0);
    const report = JSON.parse(addedAgain.stdout.toString());
    expect(report.action).toBe("already-installed");
    expect(report.wasAlreadyInstalled).toBe(true);
    expect(report.guidance.join("\n")).toContain(
      "capshelf status skills/hello --diff",
    );
    expect(report.guidance.join("\n")).toContain(
      "capshelf update skills/hello",
    );
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(manifestPath).text()).toBe(manifestBefore);
    expect(await file(lockPath).text()).toBe(lockBefore);
    expect(await file(lockPath).text()).toBe(originalLock);
  });

  test("new fragment add requires consent before removing output comments", async () => {
    const project = await tempRepo("capshelf-add-fragment-project-");
    const dataRepo = await tempRepo("capshelf-add-fragment-data-");
    const run = runInProcess(project);
    const base = join(dataRepo, "settings", "base");
    const extra = join(dataRepo, "settings", "extra");
    await mkdir(base, { recursive: true });
    await mkdir(extra, { recursive: true });
    await writeFile(
      join(base, "settings.json"),
      `${JSON.stringify({ env: { BASE: "1" } })}\n`,
    );
    await writeFile(
      join(extra, "settings.json"),
      `${JSON.stringify({ env: { EXTRA: "1" } })}\n`,
    );
    await commitAll(dataRepo, "settings fragments");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/base"])).exitCode).toBe(0);
    const output = join(project, ".claude", "settings.json");
    const current = await file(output).text();
    await writeFile(output, `// local context\n${current}`);
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const before = await Promise.all([
      file(output).text(),
      file(manifestPath).text(),
      file(lockPath).text(),
    ]);

    const refused = await run(["add", "settings/extra", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("remove config comments");
    expect(
      await Promise.all([
        file(output).text(),
        file(manifestPath).text(),
        file(lockPath).text(),
      ]),
    ).toEqual(before);

    const accepted = await run(["add", "settings/extra", "--yes", "--json"]);
    expect(accepted.exitCode).toBe(0);
    const merged = await file(output).json();
    expect(merged.env).toEqual({ BASE: "1", EXTRA: "1" });
  });
});
