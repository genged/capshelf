import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, type World } from "../support/world";
import { withWorld } from "../support/world";

const SCENARIO = "lock-migration";

interface LockFile {
  version: number;
  items: Record<string, Record<string, unknown>>;
}

async function readLock(path: string): Promise<LockFile> {
  return JSON.parse(await readFile(path, "utf-8")) as LockFile;
}

/**
 * Fixture control: rewrite a version-4 lock as the version-3 file an older
 * binary would have written. The entry keeps its commit and metadata and
 * carries the legacy `sha` instead of a pin digest.
 *
 * This constructs the state; it does not prove that an older binary produces
 * it. That claim belongs to the source-level lock tests and to a real
 * older-binary compatibility run.
 */
async function downgradeLockToV3(
  path: string,
  legacySha: string,
): Promise<void> {
  const lock = await readLock(path);
  const items: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(lock.items)) {
    if (entry.source !== "data") {
      items[key] = entry;
      continue;
    }
    const { sourcePinDigest, ...rest } = entry;
    void sourcePinDigest;
    items[key] = { ...rest, sha: legacySha };
  }
  await writeFile(path, `${JSON.stringify({ version: 3, items }, null, 2)}\n`);
}

async function seedProject(world: World): Promise<{
  project: string;
  shelf: string;
  projectLock: string;
  localLock: string;
}> {
  const shelf = await world.git.createDataRepo({
    origin: "https://example.invalid/shelf.git",
    files: {
      "skills/security-review/SKILL.md": "security review\n",
      "skills/csv-report/SKILL.md": "csv report\n",
      "skills/pr-notes/SKILL.md": "pr notes\n",
      "skills/incident-response/SKILL.md": "incident response\n",
      "settings/permissions/settings.json":
        '{"permissions":{"allow":["Bash(git status)"]}}\n',
    },
  });
  const project = await world.git.createProject("platform");
  expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
  expectExit(
    await world.capshelf(project, ["add", "skills/security-review"]),
    0,
  );
  expectExit(await world.capshelf(project, ["add", "skills/csv-report"]), 0);
  expectExit(await world.capshelf(project, ["add", "settings/permissions"]), 0);
  expectExit(
    await world.capshelf(project, ["add", "skills/pr-notes", "--local"]),
    0,
  );
  // The marker records intent about existing drift, so the edit comes first.
  // It also has to exist before the downgrade: keep-local writes a lock, and
  // every lock writer refuses an unmigrated project.
  await writeFile(
    join(project, ".agents", "skills", "security-review", "SKILL.md"),
    "security review\nplatform additions\n",
  );
  expectExit(
    await world.capshelf(project, [
      "keep-local",
      "skills/security-review",
      "--reason",
      "platform is PCI-scoped",
    ]),
    0,
  );
  return {
    project,
    shelf,
    projectLock: join(project, ".capshelf", "capshelf.lock.json"),
    localLock: join(project, ".capshelf", "local.lock.json"),
  };
}

test(
  "an unmigrated project reads normally, refuses every lock writer, and converts both locks in one transaction",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with a legacy lock, reads keep working and writers refuse with migration guidance; lock migrate converts the project and local locks together while preserving appliedAt, needs, and the keep-local marker",
      labels: ["reproduced-user-workflow", "constructed-recovery-state"],
      proofLimits: [
        "the legacy lock is written by the test, so this proves recovery from that state, not that an older capshelf produces it",
        "no older capshelf binary is run, so the one-way refusal an old binary gives a version-4 lock is not exercised here",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const { project, projectLock, localLock } = await seedProject(world);

      const beforeV4 = await readLock(projectLock);
      const markerBefore = beforeV4.items["data/skills/security-review"];
      expect(markerBefore?.local).toBe(true);
      expect(markerBefore?.localReason).toBe("platform is PCI-scoped");

      await downgradeLockToV3(projectLock, "0123456789ab");
      await downgradeLockToV3(localLock, "0123456789ab");
      expect((await readLock(projectLock)).version).toBe(3);
      expect((await readLock(localLock)).version).toBe(3);

      // Reads keep working against the old lock.
      const status = await world.capshelf(project, ["status", "--json"]);
      expectExit(status, 0);
      expect(
        statusRow(parseStatusRows(status.stdout), "skills", "csv-report").name,
      ).toBe("csv-report");

      // Every writer refuses, and refuses without touching either lock.
      const before = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      for (const args of [
        ["add", "skills/incident-response"],
        ["update", "skills/csv-report"],
        ["keep-local", "skills/csv-report"],
        ["rm", "skills/csv-report", "--yes"],
      ]) {
        const refused = await world.capshelf(project, args);
        expectExit(refused, 3);
        expectOutputContains(refused, "capshelf lock migrate");
      }
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "lock writers against a legacy lock",
      );

      // A dry run reports the plan and writes nothing.
      const dryRun = await world.capshelf(project, [
        "lock",
        "migrate",
        "--dry-run",
        "--json",
      ]);
      expectExit(dryRun, 0);
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "lock migrate --dry-run",
      );

      const migration = await world.capshelf(project, ["lock", "migrate"]);
      expectExit(migration, 0);
      // The fixture's legacy `sha` disagrees with the commit it names, and
      // that contradiction is what version 4 removes, so the migration says
      // so rather than repairing it silently (docs/cli.md:1070-1072).
      expectOutputContains(migration, "repaired legacy identity");

      const migrated = await readLock(projectLock);
      const migratedLocal = await readLock(localLock);
      expect(migrated.version).toBe(4);
      expect(migratedLocal.version).toBe(4);

      const marker = migrated.items["data/skills/security-review"];
      expect(marker?.local).toBe(true);
      expect(marker?.localReason).toBe("platform is PCI-scoped");
      expect(marker?.appliedAt).toBe(markerBefore?.appliedAt);
      expect(marker?.sha).toBeUndefined();
      expect(typeof marker?.sourcePinDigest).toBe("string");
      // The migration selects no new content: the commit it resolves is the
      // one the legacy entry named.
      expect(marker?.sourceCommit).toBe(
        beforeV4.items["data/skills/security-review"]?.sourceCommit,
      );

      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a blocked entry stops the migration until the user chooses, and a fragment cannot be re-pinned",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "an unresolvable source blocks the migration with nothing written, --repin resolves a copy item, --remove-item resolves a fragment, and re-pinning a fragment is refused",
      labels: ["reproduced-user-workflow", "constructed-recovery-state"],
      proofLimits: [
        "the legacy lock and its unresolvable commit are written by the test rather than produced by an older binary and a rewritten history",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const { project, projectLock, localLock } = await seedProject(world);
      await downgradeLockToV3(projectLock, "0123456789ab");
      await downgradeLockToV3(localLock, "0123456789ab");

      // Point two entries at a commit that exists nowhere.
      const orphan = "0".repeat(40);
      const lock = await readLock(projectLock);
      const csv = lock.items["data/skills/csv-report"];
      const fragment = lock.items["data/settings/permissions"];
      if (!csv || !fragment) throw new Error("fixture lost an entry");
      csv.sourceCommit = orphan;
      csv.needsSourceCommit = orphan;
      fragment.sourceCommit = orphan;
      fragment.needsSourceCommit = orphan;
      await writeFile(projectLock, `${JSON.stringify(lock, null, 2)}\n`);

      const before = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const blocked = await world.capshelf(project, ["lock", "migrate"]);
      expectExit(blocked, 3);
      // Every blocker is reported in one pass, not just the first.
      expectOutputContains(blocked, "skills/csv-report");
      expectOutputContains(blocked, "settings/permissions");
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "blocked lock migration",
      );

      // A fragment's former contribution cannot be told apart from a
      // project-local value, so re-pinning it is refused.
      const refusedRepin = await world.capshelf(project, [
        "lock",
        "migrate",
        "--repin",
        "skills/csv-report",
        "--repin",
        "settings/permissions",
        "--dry-run",
      ]);
      expectExit(refusedRepin, 3);
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "refused fragment re-pin",
      );

      expectExit(
        await world.capshelf(project, [
          "lock",
          "migrate",
          "--repin",
          "skills/csv-report",
          "--remove-item",
          "settings/permissions",
          "--yes",
        ]),
        0,
      );
      const migrated = await readLock(projectLock);
      expect(migrated.version).toBe(4);
      expect(Object.keys(migrated.items)).not.toContain(
        "data/settings/permissions",
      );
      expect(
        typeof migrated.items["data/skills/csv-report"]?.sourcePinDigest,
      ).toBe("string");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
