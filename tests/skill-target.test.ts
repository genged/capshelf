import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSkillTargetFree, skillTargetOwners } from "../src/skill-target";
import { createDataLockEntry, emptyLock } from "../src/lock";
import { emptyRemotesLock, remoteKey } from "../src/remotes-lock";
import { emptyNeeds } from "../src/metadata";
import { pinCurrentSource } from "../src/pin";
import { PreconditionError } from "../src/errors";
import {
  commitAll,
  rejection,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { initRemoteProject, upstreamWith } from "./remote-fixtures";

const entry = {
  source: "system",
  sha: "a".repeat(64),
  cliVersion: "0.14.0",
  appliedAt: "2024-01-01T00:00:00.000Z",
} as const;

describe("skill-target owners", () => {
  test("skills/<n> in the project lock owns the folder of plugins/<n>", async () => {
    const project = await tempDir("capshelf-target-");
    const locks = {
      project: { ...emptyLock(), items: { "data/skills/rr": entry } },
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    await expect(
      assertSkillTargetFree(project, "plugins", "rr", locks, null),
    ).rejects.toThrow(
      /\.agents\/skills\/rr is already installed by data\/skills\/rr/,
    );
  });

  test("a name that differs only in case is the same folder", async () => {
    const project = await tempDir("capshelf-target-");
    const locks = {
      project: { ...emptyLock(), items: { "data/skills/RR": entry } },
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    expect((await skillTargetOwners(project, "rr", locks)).length).toBe(1);
  });

  test("the item itself is not a conflict", async () => {
    const project = await tempDir("capshelf-target-");
    const locks = {
      project: { ...emptyLock(), items: { "data/plugins/rr": entry } },
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    await assertSkillTargetFree(project, "plugins", "rr", locks, {
      key: "data/plugins/rr",
    });
  });

  test("an adopt passes its remote row as self, and a lock owner still refuses", async () => {
    const project = await tempDir("capshelf-target-");
    const remotes = emptyRemotesLock();
    remotes.items[remoteKey("plugins", "rr")] = {
      upstream: "https://example.com/o/r",
      ref: "main",
      subpath: "plugins/rr",
      sourceCommit: "1".repeat(40),
      sourcePinDigest: "b".repeat(64),
      appliedAt: "2024-01-01T00:00:00.000Z",
    };
    await writeFile(
      join(project, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { rr: { source: "o/r" } } }),
    );
    const self = { key: remoteKey("plugins", "rr") };
    const alone = { project: emptyLock(), local: emptyLock(), remotes };
    await assertSkillTargetFree(project, "plugins", "rr", alone, self, {
      ignoreSkillsSh: true,
    });
    await expect(
      assertSkillTargetFree(project, "plugins", "rr", alone, self),
    ).rejects.toThrow(/already installed by skills\.sh/);
    await expect(
      assertSkillTargetFree(
        project,
        "plugins",
        "rr",
        {
          ...alone,
          local: { ...emptyLock(), items: { "data/skills/rr": entry } },
        },
        self,
        { ignoreSkillsSh: true },
      ),
    ).rejects.toThrow(/already installed by data\/skills\/rr \(local scope\)/);
  });

  test("skills.sh and an unmanaged folder are owners", async () => {
    const project = await tempDir("capshelf-target-");
    await writeFile(
      join(project, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { rr: { source: "o/r" } } }),
    );
    await mkdir(join(project, ".agents", "skills", "other"), {
      recursive: true,
    });
    const locks = {
      project: emptyLock(),
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    expect((await skillTargetOwners(project, "rr", locks))[0]).toEqual({
      owner: "skills.sh",
      name: "rr",
    });
    expect((await skillTargetOwners(project, "other", locks))[0]).toEqual({
      owner: "unmanaged",
      path: join(project, ".agents", "skills", "other"),
    });
  });

  test("an unmanaged folder is found by folded name, not exact case", async () => {
    // Spec D2 guard 5 folds every owner, including an unmanaged one: a
    // committed `.agents/skills/RR` must be found for a write of `rr` on
    // every machine, including one whose filesystem does not fold case.
    const project = await tempDir("capshelf-target-");
    await mkdir(join(project, ".agents", "skills", "RR"), {
      recursive: true,
    });
    const locks = {
      project: emptyLock(),
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    expect((await skillTargetOwners(project, "rr", locks))[0]).toEqual({
      owner: "unmanaged",
      path: join(project, ".agents", "skills", "RR"),
    });
  });

  test("assertSkillTargetFree lets a first install (self null) proceed over an unmanaged folder", async () => {
    // `self === null` is `add`'s call: nothing tracks this name yet, so an
    // unmanaged folder there is add's own recovery-adopt decision
    // (`matchesPinnedInstall`), not a second owner this guard reports.
    const project = await tempDir("capshelf-target-");
    await mkdir(join(project, ".agents", "skills", "rr"), { recursive: true });
    const locks = {
      project: emptyLock(),
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    await assertSkillTargetFree(project, "plugins", "rr", locks, null);
    // The lower-level function still reports it: only the null-self
    // exemption changed, not what counts as an owner.
    expect((await skillTargetOwners(project, "rr", locks))[0]).toEqual({
      owner: "unmanaged",
      path: join(project, ".agents", "skills", "rr"),
    });
  });

  test("a first install still refuses a folded unmanaged folder", async () => {
    // The self-null exemption covers only the item's own destination. On a
    // case-sensitive volume `.agents/skills/RR` is a different folder, and
    // installing `rr` beside it gives a project that collides on a
    // teammate's case-insensitive volume.
    const project = await tempDir("capshelf-target-");
    await mkdir(join(project, ".agents", "skills", "RR"), { recursive: true });
    const locks = {
      project: emptyLock(),
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    await expect(
      assertSkillTargetFree(project, "plugins", "rr", locks, null),
    ).rejects.toThrow(/\.agents\/skills\/rr is already in use at .*\/RR/);
  });

  test("a first install refuses a folded entry beside the exact one", async () => {
    const project = await tempDir("capshelf-target-");
    await mkdir(join(project, ".agents", "skills", "rr"), { recursive: true });
    await mkdir(join(project, ".claude", "skills", "RR"), { recursive: true });
    const locks = {
      project: emptyLock(),
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    await expect(
      assertSkillTargetFree(project, "plugins", "rr", locks, null),
    ).rejects.toThrow(/already in use at .*\.claude\/skills\/RR/);
  });

  test("add plugins/rr refuses while an unmanaged .agents/skills/RR exists", async () => {
    const project = await tempRepo("capshelf-target-add-folded-project-");
    const dataRepo = await tempRepo("capshelf-target-add-folded-data-");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    await mkdir(join(project, ".agents", "skills", "RR"), { recursive: true });
    await writeFile(join(project, ".agents", "skills", "RR", "x.md"), "x\n");

    const add = await run(["add", "plugins/rr", "--yes"]);
    expect(add.exitCode).toBe(3);
    expect(add.stderr.toString()).toContain("is already in use at");
    expect(existsSync(join(project, ".agents", "skills", "rr"))).toBe(false);
  });

  test("a remote/plugins/<n> row is an owner of the folder", async () => {
    // D4: a remote row can hold either kind, and `skillTargetOwners` must see
    // a plugins row the same way it already sees a remote skills row.
    const project = await tempDir("capshelf-target-");
    const remotes = emptyRemotesLock();
    remotes.items[remoteKey("plugins", "rr")] = {
      upstream: "https://example.com/o/r",
      ref: "main",
      subpath: "plugins/rr",
      sourceCommit: "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3",
      sourcePinDigest: "a".repeat(64),
      appliedAt: "2026-09-13T00:00:00.000Z",
    };
    const locks = { project: emptyLock(), local: emptyLock(), remotes };
    expect(await skillTargetOwners(project, "rr", locks)).toEqual([
      { owner: "remote", key: "remote/plugins/rr" },
    ]);
  });

  test("a different kind at the same name is also a conflict message for the switch", async () => {
    const project = await tempDir("capshelf-target-");
    const locks = {
      project: { ...emptyLock(), items: { "data/plugins/rr": entry } },
      local: emptyLock(),
      remotes: emptyRemotesLock(),
    };
    const error = await rejection(
      assertSkillTargetFree(project, "skills", "rr", locks, null),
      PreconditionError,
    );
    expect(error.message).toContain("capshelf rm plugins/rr");
    expect(error.message).toContain("capshelf add skills/rr");
    expect(error.message).toContain(
      "after the switch, Claude Code calls the skill /rr (was rr:<skill>)",
    );
  });
});

async function writeSkill(repo: string, name: string): Promise<void> {
  await mkdir(join(repo, "skills", name), { recursive: true });
  await writeFile(
    join(repo, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: d\n---\nbody\n`,
  );
}

async function writePlugin(
  repo: string,
  name: string,
  manifestName: string,
): Promise<void> {
  await mkdir(join(repo, "plugins", name, "skills", "s"), {
    recursive: true,
  });
  await writeFile(
    join(repo, "plugins", name, "skills", "s", "SKILL.md"),
    "---\nname: s\ndescription: d\n---\nbody\n",
  );
  await mkdir(join(repo, "plugins", name, ".claude-plugin"), {
    recursive: true,
  });
  await writeFile(
    join(repo, "plugins", name, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: manifestName }),
  );
}

function lockPath(project: string): string {
  return join(project, ".capshelf", "capshelf.lock.json");
}

function localLockPath(project: string): string {
  return join(project, ".capshelf", "local.lock.json");
}

/**
 * Directly inject a second, otherwise-valid, lock entry for `kind`/`name`
 * into the project (or, with `scope: "local"`, the local) lock, bypassing
 * every writer. This is how the suite reaches the two-owner state the guard
 * exists for: with the guard active, no ordinary command sequence can create
 * `data/skills/rr` and `data/plugins/rr` in one project, so the fixture
 * stands in for a project whose lock predates this guard, or whose other
 * owner came from a command this task does not yet cover (a remote add,
 * Task 8).
 */
async function injectConflictingEntry(
  project: string,
  dataRepo: string,
  kind: "skills" | "plugins",
  name: string,
  scope: "project" | "local" = "project",
): Promise<void> {
  const pin = await pinCurrentSource(dataRepo, kind, name);
  const entry = createDataLockEntry({
    pin,
    needs: emptyNeeds(),
    needsSourceCommit: pin.sourceCommit,
  });
  const path = scope === "local" ? localLockPath(project) : lockPath(project);
  const lock = JSON.parse(await readFile(path, "utf-8"));
  lock.items[`data/${kind}/${name}`] = entry;
  await writeFile(path, JSON.stringify(lock, null, 2));
}

describe("skill-target ownership at each write (D2 guard 5)", () => {
  test("add refuses plugins/<n> while skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-add-project-");
    const dataRepo = await tempRepo("capshelf-target-add-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);

    const add = await run(["add", "plugins/rr"]);
    expect(add.exitCode).toBe(3);
    const err = add.stderr.toString();
    expect(err).toContain("is already installed by data/skills/rr");
    expect(err).toContain("capshelf rm skills/rr");
    expect(err).toContain("capshelf add plugins/rr");

    // Refused before any write: the folder still holds only the skill.
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "SKILL.md")),
    ).toBe(true);
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "skills", "s")),
    ).toBe(false);
  });

  test("move refuses to move plugins/<n> into a scope where skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-move-project-");
    const dataRepo = await tempRepo("capshelf-target-move-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const move = await run(["move", "plugins/rr", "--to", "local"]);
    expect(move.exitCode).toBe(3);
    expect(move.stderr.toString()).toContain(
      "is already installed by data/skills/rr",
    );
  });

  test("revert refuses to restore plugins/<n> while skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-revert-project-");
    const dataRepo = await tempRepo("capshelf-target-revert-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const revert = await run(["revert", "plugins/rr", "--yes"]);
    expect(revert.exitCode).toBe(3);
    expect(revert.stderr.toString()).toContain(
      "is already installed by data/skills/rr",
    );
    // Refused before any write: the folder still holds only the skill.
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "skills", "s")),
    ).toBe(false);
  });

  test("apply refuses, exit 3, when explicitly naming plugins/<n> while skills/<n> owns the folder", async () => {
    // Explicit ref: mirrors the adjacent skills.sh check — a refusal is a
    // PreconditionError thrown outside the per-item try, so it exits 3, the
    // same as every other refusal in this file.
    const project = await tempRepo("capshelf-target-apply-project-");
    const dataRepo = await tempRepo("capshelf-target-apply-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const apply = await run(["apply", "plugins/rr", "--yes"]);
    expect(apply.exitCode).toBe(3);
    expect(apply.stderr.toString()).toContain(
      "is already installed by data/skills/rr",
    );
    // Refused before any write: the folder still holds only the skill.
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "skills", "s")),
    ).toBe(false);
  });

  test("apply sweep records the conflict as a per-item error and converges the rest", async () => {
    const project = await tempRepo("capshelf-target-apply-sweep-project-");
    const dataRepo = await tempRepo("capshelf-target-apply-sweep-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await writeSkill(dataRepo, "healthy");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    expect((await run(["add", "skills/healthy"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    // No explicit ref: the conflicted targets are reported, not thrown, and
    // the unrelated healthy item still converges.
    const apply = await run(["apply", "--yes", "--json"]);
    expect(apply.exitCode).toBe(1);
    const items: Array<{ name: string; action: string; error?: string }> =
      JSON.parse(apply.stdout.toString()).items;
    const rrRows = items.filter((row) => row.name === "rr");
    expect(rrRows.length).toBeGreaterThan(0);
    for (const row of rrRows) {
      expect(row.action).toBe("error");
      expect(row.error).toContain("is already installed by");
    }
    const healthyRow = items.find((row) => row.name === "healthy");
    expect(healthyRow?.action).not.toBe("error");
  });

  test("update refuses, exit 3, when explicitly naming plugins/<n> while skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-update-project-");
    const dataRepo = await tempRepo("capshelf-target-update-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const update = await run(["update", "plugins/rr"]);
    expect(update.exitCode).toBe(3);
    expect(update.stderr.toString()).toContain(
      "is already installed by data/skills/rr",
    );
  });

  test("update sweep records the conflict as a per-item error and converges the rest", async () => {
    const project = await tempRepo("capshelf-target-update-sweep-project-");
    const dataRepo = await tempRepo("capshelf-target-update-sweep-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await writeSkill(dataRepo, "healthy");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    expect((await run(["add", "skills/healthy"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const update = await run(["update", "--json"]);
    expect(update.exitCode).toBe(1);
    const items: Array<{ name: string; action: string; error?: string }> =
      JSON.parse(update.stdout.toString()).items;
    const rrRows = items.filter((row) => row.name === "rr");
    expect(rrRows.length).toBeGreaterThan(0);
    for (const row of rrRows) {
      expect(row.action).toBe("error");
      expect(row.error).toContain("is already installed by");
    }
    const healthyRow = items.find((row) => row.name === "healthy");
    expect(healthyRow?.action).not.toBe("error");
  });

  test("share plugins/<n> refuses while skills/<n> owns the folder", async () => {
    // A skill whose tree holds a valid plugin manifest. A plain share of
    // `plugins/rr` finds no plugin lock entry, so only the folder check
    // stops a second owner of `.agents/skills/rr`.
    const project = await tempRepo("capshelf-target-share-project-");
    const dataRepo = await tempRepo("capshelf-target-share-data-");
    await writeSkill(dataRepo, "rr");
    await mkdir(join(dataRepo, "skills", "rr", ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "rr", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "rr" }),
    );
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr", "--local"])).exitCode).toBe(0);

    const share = await run(["share", "plugins/rr", "--to", "local", "--yes"]);
    expect(share.exitCode).toBe(3);
    expect(share.stderr.toString()).toContain(
      "is already installed by data/skills/rr (local scope)",
    );
    expect(existsSync(join(dataRepo, "plugins", "rr"))).toBe(false);
  });

  test("apply plugins/<n> refuses while an unmanaged folded sibling exists", async () => {
    // The lock owner explains `rr`, not `RR`. On a case-sensitive volume the
    // apply would otherwise create `rr` beside `RR`.
    const project = await tempRepo("capshelf-target-apply-folded-project-");
    const dataRepo = await tempRepo("capshelf-target-apply-folded-data-");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "plugins/rr"])).exitCode).toBe(0);
    await rm(join(project, ".agents", "skills", "rr"), {
      recursive: true,
      force: true,
    });
    await rm(join(project, ".claude", "skills", "rr"), { force: true });
    await mkdir(join(project, ".agents", "skills", "RR"), { recursive: true });

    const apply = await run(["apply", "plugins/rr", "--yes"]);
    expect(apply.exitCode).toBe(3);
    expect(apply.stderr.toString()).toContain("is already in use at");
    expect(existsSync(join(project, ".agents", "skills", "rr"))).toBe(false);
  });

  test("rm deletes the item's own folder beside an unmanaged folded sibling", async () => {
    const project = await tempRepo("capshelf-target-rm-folded-project-");
    const dataRepo = await tempRepo("capshelf-target-rm-folded-data-");
    await writeSkill(dataRepo, "rr");
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await mkdir(join(project, ".agents", "skills", "RR"), { recursive: true });

    const removed = await run(["rm", "skills/rr"]);
    expect(removed.exitCode).toBe(0);
    expect(existsSync(join(project, ".agents", "skills", "rr"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "RR"))).toBe(true);
  });

  test("rm keeps the folder when another owner still claims it", async () => {
    const project = await tempRepo("capshelf-target-rm-project-");
    const dataRepo = await tempRepo("capshelf-target-rm-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const rm = await run(["rm", "skills/rr"]);
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.toString()).toContain(
      "kept .agents/skills/rr: it is installed by data/plugins/rr",
    );

    // The lock entry and the manifest name are gone, the folder is not.
    const lock = JSON.parse(await readFile(await lockPath(project), "utf-8"));
    expect(lock.items["data/skills/rr"]).toBeUndefined();
    expect(lock.items["data/plugins/rr"]).toBeDefined();
    const manifest = JSON.parse(
      await readFile(join(project, ".capshelf", "capshelf.json"), "utf-8"),
    );
    expect(manifest.skills ?? []).not.toContain("rr");
    // The folder, and its existing content, survive untouched.
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "SKILL.md")),
    ).toBe(true);
  });

  test("rm --json reports keptBy for a kept folder", async () => {
    const project = await tempRepo("capshelf-target-rm-json-project-");
    const dataRepo = await tempRepo("capshelf-target-rm-json-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const rm = await run(["rm", "skills/rr", "--json"]);
    expect(rm.exitCode).toBe(0);
    const parsed = JSON.parse(rm.stdout.toString());
    expect(parsed.removedFiles).toBe(false);
    expect(parsed.keptBy).toBe("data/plugins/rr (project scope)");
    expect(existsSync(join(project, ".agents", "skills", "rr"))).toBe(true);
  });

  test("rm of a kept folder needs no --yes for drift caused by the other owner's content", async () => {
    // The folder also holds content the other owner (plugins/rr) put there
    // — simulating a project whose lock predates this guard, where the
    // plugin was actually materialized into the shared folder. Without the
    // fix, `rm`'s destructive-change plan would report these files as this
    // item's own local edits and refuse without `--yes`.
    const project = await tempRepo("capshelf-target-rm-drift-project-");
    const dataRepo = await tempRepo("capshelf-target-rm-drift-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");
    await mkdir(join(project, ".agents", "skills", "rr", "skills", "s"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "rr", "skills", "s", "SKILL.md"),
      "plugin skill\n",
    );

    const rm = await run(["rm", "skills/rr"]);
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.toString()).toContain(
      "kept .agents/skills/rr: it is installed by data/plugins/rr (project scope)",
    );
    // The other owner's content survives untouched.
    expect(
      existsSync(
        join(project, ".agents", "skills", "rr", "skills", "s", "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("rm --local keeps the local exclude lines when a local plugins/<n> keeps the folder", async () => {
    // `localInstallPaths` names the shared folder the same way for
    // `skills/<n>` and `plugins/<n>` — removing the exclude lines for one
    // would strip them for the other if `rm` did not skip it when kept.
    const project = await tempRepo("capshelf-target-rm-exclude-project-");
    const dataRepo = await tempRepo("capshelf-target-rm-exclude-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr", "--local"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr", "local");

    const excludePath = join(project, ".git", "info", "exclude");
    const before = await readFile(excludePath, "utf-8");
    expect(before).toContain(".agents/skills/rr/");
    expect(before).toContain(".claude/skills/rr");

    const rm = await run(["rm", "--local", "skills/rr"]);
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.toString()).toContain(
      "kept .agents/skills/rr: it is installed by data/plugins/rr (local scope)",
    );

    const after = await readFile(excludePath, "utf-8");
    expect(after).toContain(".agents/skills/rr/");
    expect(after).toContain(".claude/skills/rr");
  });
});

/**
 * A remote `skills/pdf` row and a project-lock `data/plugins/pdf` entry: two
 * owners of `.agents/skills/pdf`. A clone reaches this when a teammate
 * commits the plugin entry while this clone holds the remote row.
 */
async function remoteAndShelfOwners(scope: "project" | "local" = "project") {
  const upstream = await upstreamWith([["skills/pdf", "Extract text"]]);
  const world = await initRemoteProject();
  const run = runInProcess(world.project);
  expect((await run(["add", upstream.url, "--yes"], world.env)).exitCode).toBe(
    0,
  );
  await writePlugin(world.dataRepo, "pdf", "pdf");
  await commitAll(world.dataRepo, "plugin pdf");
  if (scope === "local" && !existsSync(localLockPath(world.project))) {
    // An empty lock at the project lock's version.
    const projectLock = JSON.parse(
      await readFile(lockPath(world.project), "utf-8"),
    );
    await writeFile(
      localLockPath(world.project),
      JSON.stringify({ ...projectLock, items: {} }),
    );
  }
  await injectConflictingEntry(
    world.project,
    world.dataRepo,
    "plugins",
    "pdf",
    scope,
  );
  return { world, run: (args: string[]) => run(args, world.env) };
}

describe("remote rows and folder ownership (D2 guard 5)", () => {
  test("rm of the remote row keeps the folder another owner claims", async () => {
    const { world, run } = await remoteAndShelfOwners();
    const folder = join(world.project, ".agents", "skills", "pdf");
    const rm = await run(["rm", "skills/pdf"]);
    expect(rm.exitCode).toBe(0);
    expect(rm.stdout.toString()).toContain(
      "kept .agents/skills/pdf: it is installed by data/plugins/pdf (project scope)",
    );
    expect(existsSync(join(folder, "SKILL.md"))).toBe(true);
    const remotes = JSON.parse(
      await readFile(
        join(world.project, ".capshelf", "remotes.lock.json"),
        "utf-8",
      ),
    );
    expect(remotes.items["remote/skills/pdf"]).toBeUndefined();
    const lock = JSON.parse(await readFile(lockPath(world.project), "utf-8"));
    expect(lock.items["data/plugins/pdf"]).toBeDefined();
  });

  test("rm --json of the remote row reports keptBy, and a local owner keeps the excludes", async () => {
    const { world, run } = await remoteAndShelfOwners("local");
    const excludePath = join(world.project, ".git", "info", "exclude");
    expect(await readFile(excludePath, "utf-8")).toContain(
      ".agents/skills/pdf",
    );
    const rm = await run(["rm", "skills/pdf", "--json"]);
    expect(rm.exitCode).toBe(0);
    const parsed = JSON.parse(rm.stdout.toString());
    expect(parsed.removedFiles).toBe(false);
    expect(parsed.keptBy).toBe("data/plugins/pdf (local scope)");
    expect(existsSync(join(world.project, ".agents", "skills", "pdf"))).toBe(
      true,
    );
    expect(await readFile(excludePath, "utf-8")).toContain(
      ".agents/skills/pdf",
    );
  });

  test("apply of the remote row refuses with exit 3, and a sweep records an error", async () => {
    const { run } = await remoteAndShelfOwners();
    const named = await run(["apply", "skills/pdf", "--yes"]);
    expect(named.exitCode).toBe(3);
    expect(named.stderr.toString()).toContain(
      "is already installed by data/plugins/pdf",
    );

    const sweep = await run(["apply", "--yes", "--json"]);
    expect(sweep.exitCode).toBe(1);
    const items: Array<{ key: string; action: string; error?: string }> =
      JSON.parse(sweep.stdout.toString()).items;
    const row = items.find((item) => item.key === "remote/skills/pdf");
    expect(row?.action).toBe("error");
    expect(row?.error).toContain("is already installed by data/plugins/pdf");
  });

  test("update of the remote row refuses with exit 3, and a sweep records an error", async () => {
    const { run } = await remoteAndShelfOwners();
    const named = await run(["update", "skills/pdf"]);
    expect(named.exitCode).toBe(3);
    expect(named.stderr.toString()).toContain(
      "is already installed by data/plugins/pdf",
    );

    const sweep = await run(["update", "--json"]);
    expect(sweep.exitCode).toBe(1);
    const items: Array<{ key: string; action: string; error?: string }> =
      JSON.parse(sweep.stdout.toString()).items;
    const row = items.find((item) => item.key === "remote/skills/pdf");
    expect(row?.action).toBe("error");
    expect(row?.error).toContain("is already installed by data/plugins/pdf");
  });
});
