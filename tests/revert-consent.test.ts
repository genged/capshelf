import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("revert destructive-change consent", () => {
  test(
    "already-current is a byte-stable no-op and preserves keep-local metadata",
    async () => {
      const project = await tempRepo("capshelf-revert-current-project-");
      const dataRepo = await tempRepo("capshelf-revert-current-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "current", "locked\n");
      await commitAll(dataRepo, "current skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/current"])).exitCode).toBe(0);
      const installed = join(
        project,
        ".agents",
        "skills",
        "current",
        "SKILL.md",
      );
      await writeFile(installed, "local\n");
      expect((await run(["keep-local", "skills/current"])).exitCode).toBe(0);
      await writeFile(installed, "locked\n");
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const before = await file(lockPath).text();

      const reverted = await run(["revert", "skills/current", "--json"]);
      expect(reverted.exitCode).toBe(0);
      expect(JSON.parse(reverted.stdout.toString()).action).toBe(
        "already-current",
      );
      expect(await file(lockPath).text()).toBe(before);
      expect(JSON.parse(before).items["data/skills/current"].local).toBe(true);

      const human = await run(["revert", "skills/current"]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout.toString()).toContain("keep-local marker is set");
      expect(human.stdout.toString()).toContain(
        "capshelf keep-local skills/current --unset",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refusal preserves drift and keep-local markers until --yes",
    async () => {
      const project = await tempRepo("capshelf-revert-drift-project-");
      const dataRepo = await tempRepo("capshelf-revert-drift-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "drift", "locked\n");
      await commitAll(dataRepo, "drift skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/drift"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "drift", "SKILL.md");
      await writeFile(installed, "local edit\n");
      expect((await run(["keep-local", "skills/drift"])).exitCode).toBe(0);
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const before = await file(lockPath).text();

      const refused = await run(["revert", "skills/drift", "--json"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        "capshelf status skills/drift --diff",
      );
      expect(await file(installed).text()).toBe("local edit\n");
      expect(await file(lockPath).text()).toBe(before);

      const accepted = await run(["revert", "skills/drift", "--yes", "--json"]);
      expect(accepted.exitCode).toBe(0);
      expect(JSON.parse(accepted.stdout.toString()).action).toBe("reconciled");
      expect(await file(installed).text()).toBe("locked\n");
      // The marker records intent, not content state: reverting to the pinned
      // base so a fresh edit can start is exactly when it is most justified.
      expect(await file(lockPath).text()).toBe(before);
      expect(
        (await file(lockPath).json()).items["data/skills/drift"].local,
      ).toBe(true);

      await writeFile(installed, "second edit\n");
      const humanRevert = await run(["revert", "skills/drift", "--yes"]);
      expect(humanRevert.exitCode).toBe(0);
      expect(humanRevert.stdout.toString()).toContain("keep-local marker kept");
      expect(humanRevert.stdout.toString()).toContain(
        "capshelf keep-local skills/drift --unset",
      );

      // Only --unset clears it, and only then does apply reconcile again.
      await writeFile(installed, "third edit\n");
      expect((await run(["apply", "skills/drift"])).exitCode).toBe(0);
      expect(await file(installed).text()).toBe("third edit\n");
      expect(
        (await run(["keep-local", "skills/drift", "--unset"])).exitCode,
      ).toBe(0);
      expect((await run(["apply", "skills/drift", "--yes"])).exitCode).toBe(0);
      expect(await file(installed).text()).toBe("locked\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "apply and update both name the reason and the --unset escape",
    async () => {
      const project = await tempRepo("capshelf-keep-local-hint-project-");
      const dataRepo = await tempRepo("capshelf-keep-local-hint-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "hinted", "locked\n");
      await commitAll(dataRepo, "hinted skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/hinted"])).exitCode).toBe(0);
      const installed = join(
        project,
        ".agents",
        "skills",
        "hinted",
        "SKILL.md",
      );
      await writeFile(installed, "local edit\n");
      expect(
        (
          await run([
            "keep-local",
            "skills/hinted",
            "--reason",
            "iterating on the checklist",
          ])
        ).exitCode,
      ).toBe(0);

      // The marker is now cleared by exactly one command, so every place it
      // takes effect has to name that command — once per run, not per item.
      for (const command of [["apply"], ["update"]]) {
        const output = await run(command);
        expect(output.exitCode).toBe(0);
        const text = output.stdout.toString();
        expect(text).toMatch(/kept.local/);
        expect(text).toContain("iterating on the checklist");
        expect(
          text.match(/capshelf keep-local skills\/hinted --unset/g),
        ).toHaveLength(1);
      }
      expect(await file(installed).text()).toBe("local edit\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "keeps the marker when reverting a drifted local-scope item",
    async () => {
      const project = await tempRepo("capshelf-revert-local-project-");
      const dataRepo = await tempRepo("capshelf-revert-local-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "scoped", "locked\n");
      await commitAll(dataRepo, "scoped skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/scoped", "--local"])).exitCode).toBe(0);
      const installed = join(
        project,
        ".agents",
        "skills",
        "scoped",
        "SKILL.md",
      );
      await writeFile(installed, "local edit\n");
      expect(
        (
          await run([
            "keep-local",
            "skills/scoped",
            "--local",
            "--reason",
            "iterating",
          ])
        ).exitCode,
      ).toBe(0);
      const localLockPath = join(project, ".capshelf", "local.lock.json");
      const before = await file(localLockPath).text();

      const reverted = await run([
        "revert",
        "skills/scoped",
        "--local",
        "--yes",
      ]);
      expect(reverted.exitCode).toBe(0);
      expect(await file(installed).text()).toBe("locked\n");
      expect(await file(localLockPath).text()).toBe(before);
      expect(
        (await file(localLockPath).json()).items["data/skills/scoped"].local,
      ).toBe(true);
      expect(reverted.stdout.toString()).toContain(
        "capshelf keep-local skills/scoped --local --unset",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "promote refuses a kept-local item and names the escape sequence",
    async () => {
      const project = await tempRepo("capshelf-revert-promote-project-");
      const dataRepo = await tempRepo("capshelf-revert-promote-data-");
      const run = runInProcess(project);
      await addSkill(dataRepo, "marked", "locked\n");
      await commitAll(dataRepo, "marked skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/marked"])).exitCode).toBe(0);
      const installed = join(
        project,
        ".agents",
        "skills",
        "marked",
        "SKILL.md",
      );
      await writeFile(installed, "local edit\n");
      expect(
        (
          await run([
            "keep-local",
            "skills/marked",
            "--reason",
            "iterating on the checklist",
          ])
        ).exitCode,
      ).toBe(0);
      const lockPath = join(project, ".capshelf", "capshelf.lock.json");
      const before = await file(lockPath).text();

      const refused = await run(["promote", "skills/marked", "-m", "share"]);
      expect(refused.exitCode).toBe(3);
      const message = refused.stderr.toString();
      expect(message).toContain(
        "marked as intentional project-local divergence",
      );
      expect(message).toContain("reason: iterating on the checklist");
      expect(message.indexOf("keep-local skills/marked --unset")).toBeLessThan(
        message.indexOf('promote skills/marked -m "<message>"'),
      );
      expect(await file(lockPath).text()).toBe(before);

      expect(
        (await run(["keep-local", "skills/marked", "--unset"])).exitCode,
      ).toBe(0);
      expect(
        (await run(["promote", "skills/marked", "-m", "share"])).exitCode,
      ).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("removes visible extras but preserves ignored local files after consent", async () => {
    const project = await tempRepo("capshelf-revert-extra-project-");
    const dataRepo = await tempRepo("capshelf-revert-extra-data-");
    const run = runInProcess(project);
    const skill = await addSkill(dataRepo, "extra", "locked\n");
    await writeFile(join(skill, ".gitignore"), "cache/\n");
    await commitAll(dataRepo, "extra skill");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/extra"])).exitCode).toBe(0);
    const installed = join(project, ".agents", "skills", "extra");
    const visible = join(installed, "notes.txt");
    const ignored = join(installed, "cache", "state.db");
    await writeFile(visible, "unique notes\n");
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(ignored, "cache state\n");

    const refused = await run(["revert", "skills/extra", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      ".agents/skills/extra/notes.txt",
    );
    expect(await file(visible).text()).toBe("unique notes\n");
    expect(await file(ignored).text()).toBe("cache state\n");

    expect(
      (await run(["revert", "skills/extra", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(visible).exists()).toBe(false);
    expect(await file(ignored).text()).toBe("cache state\n");
  });

  test("guards fragment drift and comment loss before restoring the lock", async () => {
    const project = await tempRepo("capshelf-revert-fragment-project-");
    const dataRepo = await tempRepo("capshelf-revert-fragment-data-");
    const run = runInProcess(project);
    const fragment = join(dataRepo, "settings", "theme");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ theme: "dark" })}\n`,
    );
    await commitAll(dataRepo, "theme fragment");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "settings/theme"])).exitCode).toBe(0);
    const output = join(project, ".claude", "settings.json");
    await writeFile(output, '// local context\n{"theme":"light"}\n');

    const refused = await run(["revert", "settings/theme", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      "replace a managed config contribution",
    );
    expect(refused.stderr.toString()).toContain("remove config comments");
    expect(await file(output).text()).toContain("// local context");

    expect(
      (await run(["revert", "settings/theme", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(output).json()).toEqual({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      theme: "dark",
    });
  });
});
