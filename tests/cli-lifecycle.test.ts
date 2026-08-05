import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addSkill, commitAll, runInProcess, tempRepo } from "./cli-fixtures";

describe("cli integration", () => {
  test("update rewrites installed files and bumps the lock to the new data commit", async () => {
    const project = await tempRepo("capshelf-update-real-project-");
    const dataRepo = await tempRepo("capshelf-update-real-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v1\n",
    );
    await commitAll(dataRepo, "hello v1");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockedBefore = (await file(lockPath).json()).items[
      "data/skills/hello"
    ];

    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    await writeFile(join(dataRepo, "skills", "hello", "EXTRA.md"), "extra\n");
    await commitAll(dataRepo, "hello v2");
    const newHead = (await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim();

    const update = await run(["update", "--json"]);
    expect(update.exitCode).toBe(0);
    const updateJson = JSON.parse(update.stdout.toString());
    const item = updateJson.items.find(
      (i: { key: string }) => i.key === "data/skills/hello",
    );
    expect(item.action).toBe("updated");
    expect(item.sourceCommit).toBe(newHead);

    expect(
      await file(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe("hello v2\n");
    expect(
      await file(
        join(project, ".agents", "skills", "hello", "EXTRA.md"),
      ).text(),
    ).toBe("extra\n");
    const lockedAfter = (await file(lockPath).json()).items[
      "data/skills/hello"
    ];
    expect(lockedAfter.sourceCommit).toBe(newHead);
    expect(lockedAfter.sha).not.toBe(lockedBefore.sha);
    expect(lockedAfter.sha).toBe(item.sha);

    const status = await run(["status", "skills/hello", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).items[0].state).toBe("ok");
  });

  test("update requires explicit consent before overwriting local edits", async () => {
    const project = await tempRepo("capshelf-update-drift-project-");
    const dataRepo = await tempRepo("capshelf-update-drift-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v1\n",
    );
    await commitAll(dataRepo, "hello v1");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await writeFile(installed, "local edit\n");
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    await commitAll(dataRepo, "hello v2");

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await file(lockPath).text();
    const dryRun = await run(["update", "skills/hello", "--dry-run", "--json"]);
    expect(dryRun.exitCode).toBe(0);
    expect(JSON.parse(dryRun.stdout.toString()).items[0].action).toBe(
      "would-update",
    );
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(lockPath).text()).toBe(lockBefore);

    const refused = await run(["update", "skills/hello", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stdout.toString()).toBe("");
    const refusal = JSON.parse(refused.stderr.toString());
    expect(refusal.error.message).toContain("project/data/skills/hello");
    expect(refusal.error.hint).toContain("--yes");
    expect(await file(installed).text()).toBe("local edit\n");
    expect(await file(lockPath).text()).toBe(lockBefore);

    const update = await run(["update", "skills/hello", "--yes", "--json"]);
    expect(update.exitCode).toBe(0);
    const item = JSON.parse(update.stdout.toString()).items.find(
      (i: { key: string }) => i.key === "data/skills/hello",
    );
    expect(item.action).toBe("updated");
    expect(await file(installed).text()).toBe("hello v2\n");

    const status = await run(["status", "skills/hello", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).items[0].state).toBe("ok");
  });

  test("update preflights all drift before changing any selected item", async () => {
    const project = await tempRepo("capshelf-update-preflight-project-");
    const dataRepo = await tempRepo("capshelf-update-preflight-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "first", "first v1\n");
    await addSkill(dataRepo, "second", "second v1\n");
    await commitAll(dataRepo, "initial skills");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/first"])).exitCode).toBe(0);
    expect((await run(["add", "skills/second"])).exitCode).toBe(0);

    const firstInstalled = join(
      project,
      ".agents",
      "skills",
      "first",
      "SKILL.md",
    );
    const secondInstalled = join(
      project,
      ".agents",
      "skills",
      "second",
      "SKILL.md",
    );
    await writeFile(
      join(dataRepo, "skills", "first", "SKILL.md"),
      "first v2\n",
    );
    await writeFile(
      join(dataRepo, "skills", "second", "SKILL.md"),
      "second v2\n",
    );
    await commitAll(dataRepo, "updated skills");
    await writeFile(secondInstalled, "second local edit\n");

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await file(lockPath).text();
    const update = await run(["update", "--json"]);

    expect(update.exitCode).toBe(3);
    expect(await file(firstInstalled).text()).toBe("first v1\n");
    expect(await file(secondInstalled).text()).toBe("second local edit\n");
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("apply recreates installed skills in a fresh clone bound with set-data", async () => {
    const original = await tempRepo("capshelf-apply-clone-original-");
    const clone = await tempRepo("capshelf-apply-clone-clone-");
    const dataRepo = await tempRepo("capshelf-apply-clone-data-");
    const runOriginal = runInProcess(original);
    const runClone = runInProcess(clone);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "hello");

    expect((await runOriginal(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await runOriginal(["add", "skills/hello"])).exitCode).toBe(0);

    // Simulate a fresh clone of the original project: the committed manifest
    // and lock are present, but installed outputs and the gitignored
    // .capshelf/local.json binding are not.
    await mkdir(join(clone, ".capshelf"), { recursive: true });
    for (const name of ["capshelf.json", "capshelf.lock.json"]) {
      await writeFile(
        join(clone, ".capshelf", name),
        await readFile(join(original, ".capshelf", name), "utf-8"),
      );
    }

    expect((await runClone(["set-data", dataRepo])).exitCode).toBe(0);

    const apply = await runClone(["apply", "--json"]);
    expect(apply.exitCode).toBe(0);
    const applyJson = JSON.parse(apply.stdout.toString());
    expect(applyJson.project).toBe(clone);
    expect(applyJson.dataRepo).toBe(dataRepo);
    expect(applyJson.dryRun).toBe(false);
    const item = applyJson.items.find(
      (i: { key: string }) => i.key === "data/skills/hello",
    );
    expect(item.scope).toBe("project");
    expect(item.action).toBe("reconciled");
    const lock = await file(
      join(clone, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(item.sha).toBe(lock.items["data/skills/hello"].sha);
    expect(
      await file(join(clone, ".agents", "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello\n");
    expect(
      await file(join(clone, ".claude", "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello\n");

    const status = await runClone(["status", "skills/hello", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).items[0].state).toBe("ok");
  });

  test("revert restores a locally edited skill to the locked content", async () => {
    const project = await tempRepo("capshelf-revert-project-");
    const dataRepo = await tempRepo("capshelf-revert-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v1\n",
    );
    await commitAll(dataRepo, "hello v1");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await writeFile(installed, "local edit\n");
    const drifted = await run(["status", "skills/hello", "--json"]);
    expect(drifted.exitCode).toBe(0);
    expect(JSON.parse(drifted.stdout.toString()).items[0].state).toBe(
      "drifted_local",
    );

    const revert = await run(["revert", "skills/hello", "--yes", "--json"]);
    expect(revert.exitCode).toBe(0);
    const result = JSON.parse(revert.stdout.toString());
    expect(result.action).toBe("reconciled");
    expect(result.key).toBe("data/skills/hello");
    expect(await file(installed).text()).toBe("hello v1\n");

    const status = await run(["status", "skills/hello", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).items[0].state).toBe("ok");
  });

  test("keep-local pins drifted edits so update and apply leave them alone", async () => {
    const project = await tempRepo("capshelf-keep-local-project-");
    const dataRepo = await tempRepo("capshelf-keep-local-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v1\n",
    );
    await commitAll(dataRepo, "hello v1");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
    await writeFile(installed, "local override\n");

    const keep = await run([
      "keep-local",
      "skills/hello",
      "--reason",
      "team override",
      "--json",
    ]);
    expect(keep.exitCode).toBe(0);
    expect(JSON.parse(keep.stdout.toString())).toEqual({
      source: "data",
      scope: "project",
      kind: "skills",
      name: "hello",
      local: true,
      localReason: "team override",
    });
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const entry = (await file(lockPath).json()).items["data/skills/hello"];
    expect(entry.local).toBe(true);
    expect(entry.localReason).toBe("team override");

    const pinned = await run(["status", "skills/hello", "--json"]);
    expect(pinned.exitCode).toBe(0);
    expect(JSON.parse(pinned.stdout.toString()).items[0].state).toBe(
      "kept-local",
    );

    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    await commitAll(dataRepo, "hello v2");

    const update = await run(["update", "--json"]);
    expect(update.exitCode).toBe(0);
    const updated = JSON.parse(update.stdout.toString()).items.find(
      (i: { key: string }) => i.key === "data/skills/hello",
    );
    expect(updated.action).toBe("kept-local");
    expect(await file(installed).text()).toBe("local override\n");
    const afterUpdate = (await file(lockPath).json()).items[
      "data/skills/hello"
    ];
    expect(afterUpdate.sha).toBe(entry.sha);
    expect(afterUpdate.sourceCommit).toBe(entry.sourceCommit);

    const apply = await run(["apply", "skills/hello", "--json"]);
    expect(apply.exitCode).toBe(0);
    const applied = JSON.parse(apply.stdout.toString()).items.find(
      (i: { key: string }) => i.key === "data/skills/hello",
    );
    expect(applied.action).toBe("kept-local");
    expect(await file(installed).text()).toBe("local override\n");

    const unset = await run(["keep-local", "skills/hello", "--unset"]);
    expect(unset.exitCode).toBe(0);
    const afterUnset = (await file(lockPath).json()).items["data/skills/hello"];
    expect(afterUnset.local).toBeUndefined();
    expect(afterUnset.localReason).toBeUndefined();
    const unpinned = await run(["status", "skills/hello", "--json"]);
    expect(unpinned.exitCode).toBe(0);
    expect(JSON.parse(unpinned.stdout.toString()).items[0].state).toBe(
      "drifted_and_update",
    );
  });

  test("rm at project scope deletes skill installs and un-merges settings fragments", async () => {
    const project = await tempRepo("capshelf-rm-project-project-");
    const dataRepo = await tempRepo("capshelf-rm-project-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await mkdir(join(dataRepo, "settings", "security"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "security", "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "skill and settings fragment");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
    expect((await run(["add", "settings/security"])).exitCode).toBe(0);

    // An unmanaged user key in the merged output must survive rm.
    const settingsPath = join(project, ".claude", "settings.json");
    const settings = await file(settingsPath).json();
    expect(settings.permissions.deny).toEqual(["Bash(rm *)"]);
    settings.model = "opus";
    await writeFile(settingsPath, `${JSON.stringify(settings)}\n`);

    const rmSkill = await run(["rm", "skills/hello", "--json"]);
    expect(rmSkill.exitCode).toBe(0);
    const rmSkillJson = JSON.parse(rmSkill.stdout.toString());
    expect(rmSkillJson.kind).toBe("skills");
    expect(rmSkillJson.scope).toBe("project");
    expect(rmSkillJson.removedFiles).toBe(true);
    expect(
      await file(join(project, ".agents", "skills", "hello")).exists(),
    ).toBe(false);
    expect(
      await file(join(project, ".claude", "skills", "hello")).exists(),
    ).toBe(false);

    const rmSettings = await run(["rm", "settings/security", "--json"]);
    expect(rmSettings.exitCode).toBe(0);
    const rmSettingsJson = JSON.parse(rmSettings.stdout.toString());
    expect(rmSettingsJson.kind).toBe("settings");
    expect(rmSettingsJson.removedFiles).toBe(true);
    const output = await file(settingsPath).json();
    expect(output.model).toBe("opus");
    expect(JSON.stringify(output)).not.toContain("Bash(rm *)");

    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
    expect(manifest.settings).toEqual([]);
    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/skills/hello"]).toBeUndefined();
    expect(lock.items["data/settings/security"]).toBeUndefined();
  });

  test("status reports missing_source_commit when the locked commit is unreachable", async () => {
    const project = await tempRepo("capshelf-missing-commit-project-");
    const dataRepo = await tempRepo("capshelf-missing-commit-data-");
    const run = runInProcess(project);
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "hello");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/hello"])).exitCode).toBe(0);

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lock = await file(lockPath).json();
    const bogus = "0123456789abcdef0123456789abcdef01234567";
    lock.items["data/skills/hello"].sourceCommit = bogus;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const status = await run(["status", "skills/hello", "--json"]);
    expect(status.exitCode).toBe(0);
    const row = JSON.parse(status.stdout.toString()).items[0];
    expect(row.state).toBe("missing_source_commit");
    expect(row.sourceCommit).toBe(bogus);

    expect((await run(["status", "skills/hello", "--strict"])).exitCode).toBe(
      4,
    );
  });
});
