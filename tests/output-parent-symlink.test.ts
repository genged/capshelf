import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

const SUBAGENT = "---\nname: demo\ndescription: Demo subagent.\n---\n\nDemo.\n";

interface World {
  project: string;
  outside: string;
  run: ReturnType<typeof runInProcess>;
  lockPath: string;
}

async function world(): Promise<World> {
  const project = await tempRepo("capshelf-psym-project-");
  const dataRepo = await tempRepo("capshelf-psym-data-");
  const outside = await tempDir("capshelf-psym-outside-");
  await mkdir(join(dataRepo, "codex", "config", "demo"), { recursive: true });
  await writeFile(
    join(dataRepo, "codex", "config", "demo", "config.toml"),
    'model = "demo-model"\n',
  );
  await mkdir(join(dataRepo, "subagents", "demo"), { recursive: true });
  await writeFile(join(dataRepo, "subagents", "demo", "claude.md"), SUBAGENT);
  await commitAll(dataRepo, "fragment and subagent");
  const run = runInProcess(project);
  expect(
    (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
  ).toBe(0);
  return {
    project,
    outside,
    run,
    lockPath: join(project, ".capshelf", "capshelf.lock.json"),
  };
}

describe("output parent symlink guard", () => {
  test(
    "fragment add refuses a parent symlink that leaves the project",
    async () => {
      const w = await world();
      await symlink(w.outside, join(w.project, ".codex"));
      const lockBefore = await file(w.lockPath).text();
      const result = await w.run(["add", "codex-config/demo"]);
      expect(result.exitCode).toBe(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("refusing to write");
      expect(stderr).toContain("resolves outside the project");
      expect(await readdir(w.outside)).toEqual([]);
      expect(await file(w.lockPath).text()).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "subagent add refuses a parent symlink that leaves the project",
    async () => {
      const w = await world();
      await mkdir(join(w.project, ".claude"), { recursive: true });
      await symlink(w.outside, join(w.project, ".claude", "agents"));
      const lockBefore = await file(w.lockPath).text();
      const result = await w.run(["add", "subagents/demo"]);
      expect(result.exitCode).toBe(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("refusing to write");
      expect(stderr).toContain("resolves outside the project");
      expect(await readdir(w.outside)).toEqual([]);
      expect(await file(w.lockPath).text()).toBe(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "fragment rm leaves an outside file alone after the parent became a symlink",
    async () => {
      const w = await world();
      expect((await w.run(["add", "codex-config/demo"])).exitCode).toBe(0);
      const dir = join(w.project, ".codex");
      await cp(dir, w.outside, { recursive: true });
      const outsideFile = join(w.outside, "config.toml");
      const before = await file(outsideFile).text();
      await rm(dir, { recursive: true });
      await symlink(w.outside, dir);
      const lockBefore = await file(w.lockPath).text();
      const result = await w.run(["rm", "codex-config/demo", "--yes"]);
      expect(result.exitCode).toBe(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("refusing to");
      expect(stderr).toContain("resolves outside the project");
      expect(await file(w.lockPath).text()).toBe(lockBefore);
      expect(await file(outsideFile).text()).toBe(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "subagent rm leaves an outside file alone after the parent became a symlink",
    async () => {
      const w = await world();
      expect((await w.run(["add", "subagents/demo"])).exitCode).toBe(0);
      const dir = join(w.project, ".claude", "agents");
      await cp(dir, w.outside, { recursive: true });
      const outsideFile = join(w.outside, "demo.md");
      const before = await file(outsideFile).text();
      await rm(dir, { recursive: true });
      await symlink(w.outside, dir);
      const lockBefore = await file(w.lockPath).text();
      const result = await w.run(["rm", "subagents/demo", "--yes"]);
      expect(result.exitCode).toBe(3);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("refusing to");
      expect(stderr).toContain("resolves outside the project");
      expect(await file(w.lockPath).text()).toBe(lockBefore);
      expect(await file(outsideFile).text()).toBe(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a parent symlink that stays inside the project still works",
    async () => {
      const w = await world();
      await mkdir(join(w.project, "codex-real"));
      await symlink("codex-real", join(w.project, ".codex"));
      await mkdir(join(w.project, ".claude"), { recursive: true });
      await mkdir(join(w.project, "agents-real"));
      await symlink("../agents-real", join(w.project, ".claude", "agents"));
      expect((await w.run(["add", "codex-config/demo"])).exitCode).toBe(0);
      expect((await w.run(["add", "subagents/demo"])).exitCode).toBe(0);
      expect(
        await file(join(w.project, "codex-real", "config.toml")).exists(),
      ).toBe(true);
      expect(
        await file(join(w.project, "agents-real", "demo.md")).exists(),
      ).toBe(true);
      expect((await w.run(["rm", "codex-config/demo", "--yes"])).exitCode).toBe(
        0,
      );
      expect((await w.run(["rm", "subagents/demo", "--yes"])).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
