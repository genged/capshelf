import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function tempRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  await $`git -C ${repo} remote add origin ${`https://example.invalid/${basename(repo)}`}`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

function runCli(
  cli: string,
  cwd: string,
  args: string[],
): Bun.SyncSubprocess<"pipe", "pipe"> {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("set-data fragment lock verification", () => {
  test("refuses a clone that cannot satisfy locked fragment source commits", async () => {
    const project = await tempRepo("capshelf-set-data-frag-project-");
    const originalRepo = await tempRepo("capshelf-set-data-frag-original-");
    const wrongRepo = await tempRepo("capshelf-set-data-frag-wrong-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(originalRepo, "settings", "base"), { recursive: true });
    await writeFile(
      join(originalRepo, "settings", "base", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } })}\n`,
    );
    await commitAll(originalRepo, "base settings");

    await mkdir(join(wrongRepo, "settings", "base"), { recursive: true });
    await writeFile(
      join(wrongRepo, "settings", "base", "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } })}\n`,
    );
    await commitAll(wrongRepo, "wrong settings");

    const init = runCli(cli, project, ["init", "--data", originalRepo]);
    expect(init.exitCode).toBe(0);
    const initManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    await $`git -C ${wrongRepo} remote set-url origin ${initManifest.dataRepoUpstream}`.quiet();

    const add = runCli(cli, project, ["add", "settings/base"]);
    expect(add.exitCode).toBe(0);
    const originalLocalConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();

    const result = runCli(cli, project, ["set-data", wrongRepo]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("does not contain commit");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      originalLocalConfig,
    );
  });
});
