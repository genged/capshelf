import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataKey } from "../src/lock";
import { lastTouchingCommit } from "../src/git";
import { shaOfItem } from "../src/master";
import { materializeLockEntry } from "../src/materialize";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(): Promise<string> {
  const repo = await tempDir("capshelf-materialize-repo-");
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

function isExecutable(path: string): boolean {
  return (lstatSync(path).mode & 0o111) !== 0;
}

describe("materializeLockEntry", () => {
  test("restores data item content from sourceCommit and removes stale files", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await writeFile(join(dataItem, ".gitignore"), "generated/\n");
    await writeFile(join(dataItem, ".env.1password"), "API_KEY=op://vault/key\n");
    await writeFile(join(dataItem, ".secret"), "secret\n");
    await mkdir(join(dataItem, "scripts"), { recursive: true });
    await writeFile(join(dataItem, "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(join(dataItem, "scripts", "run.sh"), 0o755);
    await mkdir(join(dataItem, "nested", ".gitignore"), { recursive: true });
    await writeFile(
      join(dataItem, "nested", ".gitignore", "ignored.txt"),
      "ignored\n",
    );
    await commitAll(dataRepo, "hello v1");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const sha = await shaOfItem(dataItem);

    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "stale.txt"), "stale\n");

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
      },
    });

    expect(result.action).toBe("reconciled");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("hello v1\n");
    expect(await file(join(installed, ".gitignore")).text()).toBe(
      "generated/\n",
    );
    expect(await file(join(installed, ".env.1password")).text()).toBe(
      "API_KEY=op://vault/key\n",
    );
    expect(isExecutable(join(installed, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(installed, ".secret"))).toBe(true);
    expect(
      existsSync(join(installed, "nested", ".gitignore", "ignored.txt")),
    ).toBe(true);
    expect(existsSync(join(installed, "stale.txt"))).toBe(false);
    expect(lstatSync(join(project, ".claude", "skills", "hello")).isSymbolicLink())
      .toBe(true);
  });

  test("dry-run reports reconciliation without touching installed files", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const sha = await shaOfItem(dataItem);

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local drift\n");
    await writeFile(join(installed, "stale.txt"), "stale\n");

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
      },
      dryRun: true,
    });

    expect(result.action).toBe("would-reconcile");
    expect(result.dryRun).toBe(true);
    expect(result.plannedSha).toBe(sha);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("local drift\n");
    expect(existsSync(join(installed, "stale.txt"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "hello"))).toBe(false);
  });

  test("does not touch keep-local data items", async () => {
    const project = await tempDir("capshelf-materialize-project-");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local\n");

    const result = await materializeLockEntry({
      project,
      dataRepo: "/unused",
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha: "locked",
        sourceCommit: "commit",
        appliedAt: new Date().toISOString(),
        local: true,
        localReason: "project-specific",
      },
    });

    expect(result.action).toBe("kept-local");
    expect(result.message).toBe("project-specific");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("local\n");
  });
});
