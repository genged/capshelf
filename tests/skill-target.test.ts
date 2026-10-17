import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSkillTargetFree, skillTargetOwners } from "../src/skill-target";
import { createDataLockEntry, emptyLock } from "../src/lock";
import { emptyRemotesLock } from "../src/remotes-lock";
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

async function lockPath(project: string): Promise<string> {
  return join(project, ".capshelf", "capshelf.lock.json");
}

/**
 * Directly inject a second, otherwise-valid, lock entry for `kind`/`name`
 * into the project lock, bypassing every writer. This is how the suite
 * reaches the two-owner state the guard exists for: with the guard active,
 * no ordinary command sequence can create `data/skills/rr` and
 * `data/plugins/rr` in one project, so the fixture stands in for a project
 * whose lock predates this guard, or whose other owner came from a command
 * this task does not yet cover (a remote add, Task 8).
 */
async function injectConflictingEntry(
  project: string,
  dataRepo: string,
  kind: "skills" | "plugins",
  name: string,
): Promise<void> {
  const pin = await pinCurrentSource(dataRepo, kind, name);
  const entry = createDataLockEntry({
    pin,
    needs: emptyNeeds(),
    needsSourceCommit: pin.sourceCommit,
  });
  const path = await lockPath(project);
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

  test("apply reports an error for plugins/<n> while skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-apply-project-");
    const dataRepo = await tempRepo("capshelf-target-apply-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const apply = await run(["apply", "plugins/rr", "--yes", "--json"]);
    expect(apply.exitCode).toBe(1);
    const parsed = JSON.parse(apply.stdout.toString());
    expect(parsed.items[0].action).toBe("error");
    expect(parsed.items[0].error).toContain(
      "is already installed by data/skills/rr",
    );
    // Refused before any write: the folder still holds only the skill.
    expect(
      existsSync(join(project, ".agents", "skills", "rr", "skills", "s")),
    ).toBe(false);
  });

  test("update reports an error for plugins/<n> while skills/<n> owns the folder", async () => {
    const project = await tempRepo("capshelf-target-update-project-");
    const dataRepo = await tempRepo("capshelf-target-update-data-");
    await writeSkill(dataRepo, "rr");
    await writePlugin(dataRepo, "rr", "rr");
    await commitAll(dataRepo, "baseline");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/rr"])).exitCode).toBe(0);
    await injectConflictingEntry(project, dataRepo, "plugins", "rr");

    const update = await run(["update", "plugins/rr", "--json"]);
    expect(update.exitCode).toBe(1);
    const parsed = JSON.parse(update.stdout.toString());
    expect(parsed.items[0].action).toBe("error");
    expect(parsed.items[0].error).toContain(
      "is already installed by data/skills/rr",
    );
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
    expect(parsed.keptBy).toBe("data/plugins/rr");
    expect(existsSync(join(project, ".agents", "skills", "rr"))).toBe(true);
  });
});
