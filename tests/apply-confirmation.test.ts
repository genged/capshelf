import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addSkill, commitAll, runInProcess, tempRepo } from "./cli-fixtures";

describe("apply destructive-change preflight", () => {
  test("reports managed drift, refuses non-interactively, and accepts --yes", async () => {
    const project = await tempRepo("capshelf-apply-consent-project-");
    const dataRepo = await tempRepo("capshelf-apply-consent-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "hello", "locked content\n");
    await commitAll(dataRepo, "hello");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    await writeFile(installed, "local edit\n");
    const lockBefore = await file(lockPath).text();

    const dryRun = await run(["apply", "skills/hello", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{
        scope: string;
        item?: string;
        path: string;
        reason: string;
        reviewCommand?: string;
      }>;
    };
    expect(dryReport.destructiveChanges).toContainEqual({
      scope: "project",
      item: "project/data/skills/hello",
      path: ".agents/skills/hello/SKILL.md",
      reason: "managed_content",
      reviewCommand: "capshelf status skills/hello --diff",
    });
    expect(await file(installed).text()).toBe("local edit\n");

    const refused = await run(["apply", "skills/hello", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      ".agents/skills/hello/SKILL.md",
    );
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(lockPath).text()).toBe(lockBefore);

    expect(
      (await run(["apply", "skills/hello", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(installed).text()).toBe("locked content\n");
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("preflights every target before recreating an earlier missing item", async () => {
    const project = await tempRepo("capshelf-apply-batch-project-");
    const dataRepo = await tempRepo("capshelf-apply-batch-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "first", "first\n");
    await addSkill(dataRepo, "second", "second\n");
    await commitAll(dataRepo, "skills");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/first"])).exitCode).toBe(0);
    expect((await run(["add", "skills/second"])).exitCode).toBe(0);

    const firstRoot = join(project, ".agents", "skills", "first");
    const second = join(project, ".agents", "skills", "second", "SKILL.md");
    await rm(firstRoot, { recursive: true });
    await writeFile(second, "second local edit\n");

    const refused = await run(["apply", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(await file(firstRoot).exists()).toBe(false);
    expect(await file(second).text()).toBe("second local edit\n");
  });

  test("recreates missing managed files while preserving ignored local state", async () => {
    const project = await tempRepo("capshelf-apply-ignored-project-");
    const dataRepo = await tempRepo("capshelf-apply-ignored-data-");
    const run = runInProcess(project);
    const skill = join(dataRepo, "skills", "cached");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, ".gitignore"), "cache/\n");
    await writeFile(join(skill, "SKILL.md"), "managed\n");
    await commitAll(dataRepo, "cached skill");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/cached"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "cached");
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(join(installed, "cache", "state.db"), "local state\n");
    await rm(join(installed, "SKILL.md"));

    const applied = await run(["apply", "skills/cached", "--json"]);
    expect(applied.exitCode).toBe(0);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("managed\n");
    expect(await file(join(installed, "cache", "state.db")).text()).toBe(
      "local state\n",
    );
  });

  test("reports fragment contribution and comment loss before writing", async () => {
    const project = await tempRepo("capshelf-apply-fragment-project-");
    const dataRepo = await tempRepo("capshelf-apply-fragment-data-");
    const run = runInProcess(project);
    const fragment = join(dataRepo, "settings", "security");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Read(.env)", "Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/security"])).exitCode).toBe(0);
    const output = join(project, ".claude", "settings.json");
    await writeFile(
      output,
      '// local rationale\n{"permissions":{"deny":["Read(.env)"]}}\n',
    );

    const dryRun = await run([
      "apply",
      "settings/security",
      "--dry-run",
      "--json",
    ]);
    expect(dryRun.exitCode).toBe(0);
    const report = JSON.parse(dryRun.stdout.toString()) as {
      destructiveChanges: Array<{ reason: string }>;
    };
    expect(report.destructiveChanges.map((change) => change.reason)).toEqual([
      "config_comments",
      "fragment_contribution",
    ]);
    expect((await run(["apply", "settings/security", "--json"])).exitCode).toBe(
      3,
    );
    expect(await file(output).text()).toContain("// local rationale");
  });
});
