import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOCK_VERSION,
  parseLock,
  assertWritableLock,
  serializeLock,
} from "../src/lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

const LOCK = join(".capshelf", "capshelf.lock.json");
const LOCAL_LOCK = join(".capshelf", "local.lock.json");

const v4 = { version: 4, items: {} };

describe("lock version 5", () => {
  test("the current version is 5", () => {
    expect(LOCK_VERSION).toBe(5);
  });
  test("a version 4 lock reads but is not writable", () => {
    const lock = parseLock(v4);
    expect(lock.version).toBe(4);
    expect(() => assertWritableLock(lock, "capshelf add")).toThrow(
      /this project's lock is version 4; capshelf add writes lock version 5/,
    );
  });
  test("a version 5 lock is writable and serializes as 5", () => {
    const lock = assertWritableLock(parseLock({ version: 5, items: {} }), "x");
    expect(JSON.parse(serializeLock(lock)).version).toBe(5);
  });
  test("a version 6 lock asks for an upgrade", () => {
    expect(() => parseLock({ version: 6, items: {} })).toThrow(
      /lock version 6 is newer than this capshelf supports/,
    );
  });
  test("a lock older than 5 that holds a plugin key is refused", () => {
    const entry = {
      source: "system",
      sha: "a".repeat(64),
      cliVersion: "0.13.0",
      appliedAt: new Date().toISOString(),
    };
    expect(() =>
      parseLock({ version: 4, items: { "system/plugins/x": entry } }),
    ).toThrow(/plugin items need lock version 5/);
  });

  test(
    "lock migrate moves a version 4 project to 5 with entries unchanged",
    async () => {
      const project = await tempRepo("capshelf-migrate-v5-project-");
      const dataRepo = await tempRepo("capshelf-migrate-v5-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "alpha", "alpha v1\n");
      await addSkill(dataRepo, "beta", "beta v1\n");
      await commitAll(dataRepo, "skills v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/alpha"])).exitCode).toBe(0);
      expect((await run(["add", "skills/beta", "--local"])).exitCode).toBe(0);

      const projectPath = join(project, LOCK);
      const localPath = join(project, LOCAL_LOCK);
      const projectBefore = await file(projectPath).json();
      const localBefore = await file(localPath).json();
      expect(projectBefore.version).toBe(LOCK_VERSION);
      expect(localBefore.version).toBe(LOCK_VERSION);
      for (const [path, lock] of [
        [projectPath, projectBefore],
        [localPath, localBefore],
      ] as const) {
        await writeFile(
          path,
          `${JSON.stringify({ ...lock, version: 4 }, null, 2)}\n`,
        );
      }

      // Data repo is renamed away to prove the 4-to-5 step never reads it.
      const movedDataRepo = `${dataRepo}-moved-away`;
      await rename(dataRepo, movedDataRepo);
      const migrated = await run(["lock", "migrate", "--yes", "--json"]);
      expect(migrated.exitCode).toBe(0);

      const projectAfter = await file(projectPath).json();
      const localAfter = await file(localPath).json();
      expect(projectAfter.version).toBe(5);
      expect(localAfter.version).toBe(5);
      expect(projectAfter.items).toEqual(projectBefore.items);
      expect(localAfter.items).toEqual(localBefore.items);

      const second = await run(["lock", "migrate", "--json"]);
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout.toString()).action).toBe(
        "already-current",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "lock migrate moves a version 4 project lock to 5 when no local lock file exists",
    async () => {
      const project = await tempRepo("capshelf-migrate-v5-no-local-");
      const dataRepo = await tempRepo("capshelf-migrate-v5-no-local-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "alpha", "alpha v1\n");
      await commitAll(dataRepo, "skills v1");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/alpha"])).exitCode).toBe(0);

      const projectPath = join(project, LOCK);
      const localPath = join(project, LOCAL_LOCK);
      expect(existsSync(localPath)).toBe(false);

      const projectBefore = await file(projectPath).json();
      expect(projectBefore.version).toBe(LOCK_VERSION);
      await writeFile(
        projectPath,
        `${JSON.stringify({ ...projectBefore, version: 4 }, null, 2)}\n`,
      );

      // A missing local lock loads as an empty v5 lock, so this is the mixed
      // v4/v5 case the fast path must also handle.
      const migrated = await run(["lock", "migrate", "--yes", "--json"]);
      expect(migrated.exitCode).toBe(0);

      const projectAfter = await file(projectPath).json();
      expect(projectAfter.version).toBe(5);
      expect(projectAfter.items).toEqual(projectBefore.items);
      expect(existsSync(localPath)).toBe(false);

      const second = await run(["lock", "migrate", "--json"]);
      expect(second.exitCode).toBe(0);
      expect(JSON.parse(second.stdout.toString()).action).toBe(
        "already-current",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
