/**
 * `share` on a copy item (skill, plugin, Pi extension) refuses `--from` and
 * `--target`. Both name a source for fragment and subagent items. Dropping
 * them would commit the installed directory instead of what the user named.
 */
import { $ } from "bun";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_INTEGRATION_TEST_TIMEOUT_MS, runInProcess } from "./cli-fixtures";
import {
  localLockPath,
  lockPath,
  manifestPath,
  rootManifestPath,
} from "../src/paths";
import { initRemoteProject, skillText } from "./remote-fixtures";
import type { RemoteProject } from "./remote-fixtures";

async function worldWithInstalledSkill(): Promise<RemoteProject> {
  const world = await initRemoteProject();
  const dir = join(world.project, ".agents", "skills", "delta");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillText("delta", "Delta skill"));
  return world;
}

async function snapshot(world: RemoteProject) {
  const read = async (path: string) =>
    existsSync(path) ? await readFile(path, "utf8") : null;
  const { project } = world;
  return {
    head: (
      await $`git -C ${world.dataRepo} rev-parse HEAD`.quiet().text()
    ).trim(),
    lock: await read(lockPath(project)),
    localLock: await read(localLockPath(project)),
    manifest: await read(manifestPath(project)),
    rootManifest: await read(rootManifestPath(project)),
  };
}

test.each([
  ["--from", "/tmp/capshelf-does-not-exist.md"],
  ["--from", ""],
  ["--target", "codex"],
])(
  "share skills/delta %s %j exits 3 and writes nothing",
  async (flag, value) => {
    const world = await worldWithInstalledSkill();
    const before = await snapshot(world);
    const result = await runInProcess(world.project)(
      ["share", "skills/delta", flag, value, "--to", "project"],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      `share skills/delta: ${flag} applies to`,
    );
    expect(await snapshot(world)).toEqual(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test.each([
  ["plugins/gh-cli", "--from", "/tmp/x.md"],
  ["plugins/gh-cli", "--target", "codex"],
  ["pi-extensions/ext", "--from", "/tmp/x.ts"],
])(
  "share %s %s exits 3",
  async (ref, flag, value) => {
    const world = await initRemoteProject();
    const before = await snapshot(world);
    const result = await runInProcess(world.project)(
      ["share", ref, flag, value],
      world.env,
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      `share ${ref}: ${flag} applies to`,
    );
    expect(await snapshot(world)).toEqual(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "share skills/delta without those flags still succeeds",
  async () => {
    const world = await worldWithInstalledSkill();
    const before = await snapshot(world);
    const result = await runInProcess(world.project)(
      ["share", "skills/delta", "--to", "project"],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect((await snapshot(world)).head).not.toBe(before.head);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "share subagents/reviewer with --target codex and --from still succeeds",
  async () => {
    const world = await initRemoteProject();
    const codex = `name = "reviewer"
description = "Review changes"
developer_instructions = "Review the change carefully."
`;
    const output = join(world.project, ".codex", "agents", "reviewer.toml");
    await mkdir(join(world.project, ".codex", "agents"), { recursive: true });
    await writeFile(output, codex);
    const before = await snapshot(world);
    const result = await runInProcess(world.project)(
      [
        "share",
        "subagents/reviewer",
        "--target",
        "codex",
        "--from",
        output,
        "--to",
        "project",
      ],
      world.env,
    );
    expect(result.exitCode).toBe(0);
    expect(
      await readFile(
        join(world.dataRepo, "subagents", "reviewer", "codex.toml"),
        "utf8",
      ),
    ).toBe(codex);
    const after = await snapshot(world);
    expect(after.head).not.toBe(before.head);
    expect(after.lock).toContain("subagents/reviewer");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
