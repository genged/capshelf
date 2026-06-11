import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(
  prefix: string,
  opts: { origin?: string | null } = {},
): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  const origin =
    opts.origin === undefined
      ? `https://example.invalid/${basename(repo)}`
      : opts.origin;
  if (origin !== null) {
    await $`git -C ${repo} remote add origin ${origin}`.quiet();
  }
  return repo;
}

async function initProject(project: string, dataRepo: string): Promise<void> {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const result = Bun.spawnSync({
    cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
    cwd: project,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

describe("human-readable DX output", () => {
  test("init suggests discovery and bundle next steps", async () => {
    const project = await tempRepo("capshelf-dx-init-project-");
    const dataRepo = await tempRepo("capshelf-dx-init-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("next:");
    expect(stdout).toContain("capshelf search <task>");
    expect(stdout).toContain("capshelf ls");
    expect(stdout).toContain("capshelf add bundles/<name>");
  });

  test("share prints the local data repo location without push guidance when there is no origin", async () => {
    const project = await tempRepo("capshelf-dx-share-project-");
    const dataRepo = await tempRepo("capshelf-dx-share-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await initProject(project, dataRepo);
    await mkdir(join(project, ".agents", "skills", "hello"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello\n",
    );

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "skills/hello",
        "--to",
        "project",
        "-m",
        "share hello",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`committed to local data repo:\n  ${dataRepo}`);
    expect(stdout).not.toContain("to share upstream:");
  });

  test("share prints push guidance when the data repo has an origin", async () => {
    const project = await tempRepo("capshelf-dx-share-origin-project-");
    const dataRepo = await tempRepo("capshelf-dx-share-origin-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await initProject(project, dataRepo);
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ env: { TEAM_MODE: "platform" } }, null, 2),
    );

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "settings/team-env",
        "--pick",
        "env",
        "--to",
        "project",
        "-m",
        "share team env",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      `to share upstream:\n  cd ${dataRepo}\n  git push`,
    );
  });
});
