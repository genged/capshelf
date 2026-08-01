import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitAll, runInProcess, tempRepo } from "./cli-fixtures";

describe("promote --merge command validation", () => {
  test("rejects --merge with --stale-ok before project or item resolution", async () => {
    const project = await mkdtemp(join(tmpdir(), "capshelf-merge-flags-"));
    const before = await readdir(project);
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "..", "src", "cli.ts"),
        "promote",
        "skills/missing",
        "--merge",
        "--stale-ok",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "--merge and --stale-ok cannot be combined",
    );
    expect(await readdir(project)).toEqual(before);
  });

  test("local-scope merge changes only the local lock", async () => {
    const dataRepo = await tempRepo("capshelf-merge-local-data-");
    const project = await tempRepo("capshelf-merge-local-project-");
    const run = runInProcess(project);
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await commitAll(dataRepo, "base");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "skills/hello", "--local"])).exitCode).toBe(0);
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockBefore = await file(projectLockPath).text();
    const localLockBefore = await file(localLockPath).text();

    await writeFile(join(dataItem, "upstream.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".agents", "skills", "hello");
    await writeFile(join(installed, "local.txt"), "local\n");
    const promoted = await run([
      "promote",
      "skills/hello",
      "--local",
      "--merge",
      "--json",
    ]);

    expect(promoted.exitCode).toBe(0);
    const result = JSON.parse(promoted.stdout.toString());
    expect(result.merged).toBe(true);
    expect(result.committed).toBe(true);
    expect(await file(projectLockPath).text()).toBe(projectLockBefore);
    expect(await file(localLockPath).text()).not.toBe(localLockBefore);
    expect(await file(join(installed, "upstream.txt")).text()).toBe(
      "upstream\n",
    );
  });

  test("project Pi merge retains executable-code warnings", async () => {
    const dataRepo = await tempRepo("capshelf-merge-pi-data-");
    const project = await tempRepo("capshelf-merge-pi-project-");
    const run = runInProcess(project);
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export const base = true;\n");
    await commitAll(dataRepo, "base");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "pi-extensions/guard"])).exitCode).toBe(0);
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const localLockExistedBefore = await file(localLockPath).exists();

    await writeFile(
      join(extension, "upstream.ts"),
      "export const upstream = true;\n",
    );
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".pi", "extensions", "guard");
    await writeFile(
      join(installed, "local.ts"),
      "export const local = true;\n",
    );
    const promoted = await run([
      "promote",
      "pi-extensions/guard",
      "--merge",
      "--json",
    ]);

    expect(promoted.exitCode).toBe(0);
    const result = JSON.parse(promoted.stdout.toString());
    expect(result.merged).toBe(true);
    expect(
      result.runtimeWarnings.map((warning: { type: string }) => warning.type),
    ).toContain("pi_extension_executes_code");
    expect(await file(localLockPath).exists()).toBe(localLockExistedBefore);
  });

  test("local Pi merge is rejected before data or lock writes", async () => {
    const dataRepo = await tempRepo("capshelf-merge-local-pi-data-");
    const project = await tempRepo("capshelf-merge-local-pi-project-");
    const run = runInProcess(project);
    const extension = join(dataRepo, "pi", "extensions", "guard");
    await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "index.ts"), "export const base = true;\n");
    await commitAll(dataRepo, "base");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect(
      (await run(["add", "pi-extensions/guard", "--local"])).exitCode,
    ).toBe(0);
    const headBefore = (
      await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const lockBefore = await file(localLockPath).text();

    const rejected = await run([
      "promote",
      "pi-extensions/guard",
      "--local",
      "--merge",
      "--json",
    ]);

    expect(rejected.exitCode).toBe(3);
    expect(JSON.parse(rejected.stderr.toString()).error.message).toContain(
      "supported only in project scope",
    );
    expect((await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(localLockPath).text()).toBe(lockBefore);
  });

  test("non-stale --merge follows normal promotion and omits merge fields", async () => {
    const dataRepo = await tempRepo("capshelf-merge-nonstale-data-");
    const project = await tempRepo("capshelf-merge-nonstale-project-");
    const run = runInProcess(project);
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await commitAll(dataRepo, "base");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    await writeFile(
      join(project, ".agents", "skills", "hello", "local.txt"),
      "local\n",
    );

    const promoted = await run([
      "promote",
      "skills/hello",
      "--merge",
      "--json",
    ]);

    expect(promoted.exitCode).toBe(0);
    const result = JSON.parse(promoted.stdout.toString());
    expect(result.action).toBe("promoted");
    expect(result.merged).toBeUndefined();
    expect(result.mergeBase).toBeUndefined();
    expect(result.mergedUpstreamCommit).toBeUndefined();
  });

  test("fragment --merge rejects before changing source, HEAD, or lock", async () => {
    const dataRepo = await tempRepo("capshelf-merge-fragment-data-");
    const project = await tempRepo("capshelf-merge-fragment-project-");
    const run = runInProcess(project);
    const source = join(dataRepo, "settings", "theme");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "settings/theme"])).exitCode).toBe(0);
    const headBefore = (
      await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    const sourceBefore = await file(join(source, "settings.json")).text();
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await file(lockPath).text();
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const manifestBefore = await file(manifestPath).text();
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const localLockExistedBefore = await file(localLockPath).exists();

    const rejected = await run([
      "promote",
      "settings/theme",
      "--merge",
      "--json",
    ]);

    expect(rejected.exitCode).toBe(3);
    expect(JSON.parse(rejected.stderr.toString()).error.message).toContain(
      "is a fragment",
    );
    expect((await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(join(source, "settings.json")).text()).toBe(sourceBefore);
    expect(await file(lockPath).text()).toBe(lockBefore);
    expect(await file(manifestPath).text()).toBe(manifestBefore);
    expect(await file(localLockPath).exists()).toBe(localLockExistedBefore);
  });

  test("JSON conflict envelope has exit 3 and sorted item-relative paths", async () => {
    const dataRepo = await tempRepo("capshelf-merge-conflict-data-");
    const project = await tempRepo("capshelf-merge-conflict-project-");
    const run = runInProcess(project);
    const dataItem = join(dataRepo, "skills", "hello");
    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "base\n");
    await writeFile(join(dataItem, "z.txt"), "base\n");
    await writeFile(join(dataItem, "a.txt"), "base\n");
    await commitAll(dataRepo, "base");
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    await writeFile(join(dataItem, "z.txt"), "upstream\n");
    await writeFile(join(dataItem, "a.txt"), "upstream\n");
    await commitAll(dataRepo, "upstream");
    const installed = join(project, ".agents", "skills", "hello");
    await writeFile(join(installed, "z.txt"), "local\n");
    await writeFile(join(installed, "a.txt"), "local\n");
    const headBefore = (
      await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await file(lockPath).text();
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const manifestBefore = await file(manifestPath).text();
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const localLockExistedBefore = await file(localLockPath).exists();

    const conflicted = await run([
      "promote",
      "skills/hello",
      "--merge",
      "--json",
    ]);

    expect(conflicted.exitCode).toBe(3);
    expect(conflicted.stdout.toString()).toBe("");
    const envelope = JSON.parse(conflicted.stderr.toString());
    expect(envelope.error.exitCode).toBe(3);
    const message = envelope.error.message as string;
    expect(message).toContain("a.txt");
    expect(message).toContain("z.txt");
    expect(message.indexOf("a.txt")).toBeLessThan(message.indexOf("z.txt"));
    expect((await Bun.$`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(lockPath).text()).toBe(lockBefore);
    expect(await file(manifestPath).text()).toBe(manifestBefore);
    expect(await file(localLockPath).exists()).toBe(localLockExistedBefore);
  });
});
