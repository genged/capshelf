import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shaOfGitVisibleItem } from "../src/master";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

/**
 * PIN-12: `capshelf lock migrate` is the only v2/v3 → v4 path, and it is total
 * and transactional. The properties worth pinning are the ones a partial
 * migration would break: both lock files convert together, a single
 * unresolvable source blocks the whole run and writes nothing, and a second
 * run is a no-op.
 */

const LOCK = join(".capshelf", "capshelf.lock.json");
const LOCAL_LOCK = join(".capshelf", "local.lock.json");

interface LegacyEntry {
  source: "data";
  sha: string;
  sourceCommit: string;
  appliedAt: string;
  label?: string;
}

/**
 * Rewrite a migrated project back to a genuine version-3 lock: identity is the
 * data repo working-tree hash and there is no `sourcePinDigest` anywhere.
 */
async function downgradeToV3(
  project: string,
  dataRepo: string,
  refs: Array<{
    file: string;
    kind: string;
    name: string;
    repoRelPath: string;
  }>,
): Promise<void> {
  const byFile = new Map<string, Record<string, unknown>>();
  for (const ref of refs) {
    const path = join(project, ref.file);
    const lock =
      byFile.get(path) ??
      (JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>);
    byFile.set(path, lock);
    const items = lock.items as Record<string, Record<string, unknown>>;
    const key = `data/${ref.kind}/${ref.name}`;
    const entry = items[key]!;
    const legacy: LegacyEntry = {
      source: "data",
      sha: await shaOfGitVisibleItem(dataRepo, ref.repoRelPath),
      sourceCommit: entry.sourceCommit as string,
      appliedAt: entry.appliedAt as string,
      ...(entry.label !== undefined && { label: entry.label as string }),
    };
    items[key] = {
      ...legacy,
      needs: entry.needs ?? null,
      needsSourceCommit: entry.needsSourceCommit ?? null,
    };
    lock.version = 3;
  }
  for (const [path, lock] of byFile) {
    await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
  }
}

async function migratedProject(prefix: string): Promise<{
  project: string;
  dataRepo: string;
  run: ReturnType<typeof runInProcess>;
}> {
  const project = await tempRepo(`${prefix}-project-`);
  const dataRepo = await tempRepo(`${prefix}-data-`);
  const run = runInProcess(project);
  await addSkill(dataRepo, "alpha", "alpha v1\n");
  await addSkill(dataRepo, "beta", "beta v1\n");
  await commitAll(dataRepo, "skills v1");
  expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
  expect((await run(["add", "skills/alpha"])).exitCode).toBe(0);
  expect((await run(["add", "skills/beta", "--local"])).exitCode).toBe(0);
  return { project, dataRepo, run };
}

describe("capshelf lock migrate", () => {
  test(
    "converts the project and local locks together and is a no-op afterwards",
    async () => {
      const { project, dataRepo, run } = await migratedProject(
        "capshelf-migrate-clean",
      );
      await downgradeToV3(project, dataRepo, [
        {
          file: LOCK,
          kind: "skills",
          name: "alpha",
          repoRelPath: "skills/alpha",
        },
        {
          file: LOCAL_LOCK,
          kind: "skills",
          name: "beta",
          repoRelPath: "skills/beta",
        },
      ]);

      const dry = await run(["lock", "migrate", "--dry-run", "--json"]);
      expect(dry.exitCode).toBe(0);
      const preview = JSON.parse(dry.stdout.toString());
      expect(preview.action).toBe("would-migrate");
      expect(preview.converted.sort()).toEqual([
        "local/skills/beta",
        "project/skills/alpha",
      ]);
      expect(preview.blocked).toEqual([]);
      // A dry run writes nothing.
      expect((await file(join(project, LOCK)).json()).version).toBe(3);

      expect((await run(["lock", "migrate"])).exitCode).toBe(0);
      const projectLock = await file(join(project, LOCK)).json();
      const localLock = await file(join(project, LOCAL_LOCK)).json();
      expect(projectLock.version).toBe(4);
      expect(localLock.version).toBe(4);
      for (const [lock, key] of [
        [projectLock, "data/skills/alpha"],
        [localLock, "data/skills/beta"],
      ] as const) {
        const entry = lock.items[key];
        expect(entry.sha).toBeUndefined();
        expect(entry.sourcePinDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
      }

      // The migration selected no new content, so the items still apply.
      const applied = await run(["apply"]);
      expect(applied.exitCode).toBe(0);
      expect(applied.stdout.toString()).toContain("already-current");

      const second = await run(["lock", "migrate"]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).toContain("already version 4");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a legacy hash that disagrees with its commit is reported as repaired",
    async () => {
      const { project, dataRepo, run } = await migratedProject(
        "capshelf-migrate-repair",
      );
      await downgradeToV3(project, dataRepo, [
        {
          file: LOCK,
          kind: "skills",
          name: "alpha",
          repoRelPath: "skills/alpha",
        },
        {
          file: LOCAL_LOCK,
          kind: "skills",
          name: "beta",
          repoRelPath: "skills/beta",
        },
      ]);
      // The exact shape of the original bug: a recorded hash the pinned commit
      // cannot produce. Migration keeps the commit and replaces the proof.
      const lockPath = join(project, LOCK);
      const lock = JSON.parse(await readFile(lockPath, "utf-8"));
      const before = lock.items["data/skills/alpha"].sourceCommit;
      lock.items["data/skills/alpha"].sha = "0123456789ab";
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

      const migrated = await run(["lock", "migrate", "--json"]);
      expect(migrated.exitCode).toBe(0);
      const report = JSON.parse(migrated.stdout.toString());
      expect(report.repairedLegacyIdentity).toEqual(["project/skills/alpha"]);

      const after = await file(lockPath).json();
      expect(after.items["data/skills/alpha"].sourceCommit).toBe(before);
      expect((await run(["apply", "skills/alpha"])).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one unresolvable source blocks the whole migration and writes nothing",
    async () => {
      const { project, dataRepo, run } = await migratedProject(
        "capshelf-migrate-blocked",
      );
      await downgradeToV3(project, dataRepo, [
        {
          file: LOCK,
          kind: "skills",
          name: "alpha",
          repoRelPath: "skills/alpha",
        },
        {
          file: LOCAL_LOCK,
          kind: "skills",
          name: "beta",
          repoRelPath: "skills/beta",
        },
      ]);
      const localPath = join(project, LOCAL_LOCK);
      const localLock = JSON.parse(await readFile(localPath, "utf-8"));
      localLock.items["data/skills/beta"].sourceCommit = "0".repeat(40);
      await writeFile(localPath, `${JSON.stringify(localLock, null, 2)}\n`);
      const projectBytes = await readFile(join(project, LOCK), "utf-8");
      const localBytes = await readFile(localPath, "utf-8");

      const blocked = await run(["lock", "migrate"]);
      expect(blocked.exitCode).toBe(3);
      const text = blocked.stdout.toString();
      expect(text).toContain("Lock migration blocked");
      expect(text).toContain("skills/beta");
      expect(text).toContain("No lock or installed file was changed.");
      // The healthy project entry must not be converted on its own: no
      // observable state has one v3 lock beside one v4 lock.
      expect(await readFile(join(project, LOCK), "utf-8")).toBe(projectBytes);
      expect(await readFile(localPath, "utf-8")).toBe(localBytes);

      // An explicit re-pin is the way through, and it converts both files.
      const repaired = await run([
        "lock",
        "migrate",
        "--repin",
        "skills/beta",
        "--yes",
      ]);
      expect(repaired.exitCode).toBe(0);
      expect((await file(join(project, LOCK)).json()).version).toBe(4);
      expect((await file(localPath).json()).version).toBe(4);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a managed path that declares an external filter driver blocks migration",
    async () => {
      const { project, dataRepo, run } = await migratedProject(
        "capshelf-migrate-filter",
      );
      await downgradeToV3(project, dataRepo, [
        {
          file: LOCK,
          kind: "skills",
          name: "alpha",
          repoRelPath: "skills/alpha",
        },
        {
          file: LOCAL_LOCK,
          kind: "skills",
          name: "beta",
          repoRelPath: "skills/beta",
        },
      ]);
      await writeFile(
        join(dataRepo, ".gitattributes"),
        "skills/alpha/** filter=git-crypt\n",
      );
      await commitAll(dataRepo, "encrypt alpha");
      // The pin still names the old commit, and the attribute is read *from
      // that commit*, so re-pinning is what exposes it. Point the entry at the
      // commit that declares the driver.
      const lockPath = join(project, LOCK);
      const lock = JSON.parse(await readFile(lockPath, "utf-8"));
      lock.items["data/skills/alpha"].sourceCommit = (
        await $`git -C ${dataRepo} rev-parse HEAD`.quiet()
      ).stdout
        .toString()
        .trim();
      await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

      const blocked = await run(["lock", "migrate"]);
      expect(blocked.exitCode).toBe(3);
      expect(blocked.stdout.toString()).toContain("filter=git-crypt");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
