import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  runInProcess,
  tempRepo,
} from "./cli-fixtures";

describe("rm destructive-change consent", () => {
  test("removes an unmodified locked item without prompting", async () => {
    const project = await tempRepo("capshelf-rm-clean-project-");
    const dataRepo = await tempRepo("capshelf-rm-clean-data-");
    const run = runInProcess(project);
    await addSkill(dataRepo, "clean", "clean\n");
    await commitAll(dataRepo, "clean skill");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/clean"])).exitCode).toBe(0);

    const removed = await run(["rm", "skills/clean", "--json"]);
    expect(removed.exitCode).toBe(0);
    expect(
      await file(
        join(project, ".agents", "skills", "clean", "SKILL.md"),
      ).exists(),
    ).toBe(false);
  });

  test("detects ignored files and mode drift before deleting a copy item", async () => {
    const project = await tempRepo("capshelf-rm-copy-project-");
    const dataRepo = await tempRepo("capshelf-rm-copy-data-");
    const run = runInProcess(project);
    const skill = await addSkill(dataRepo, "stateful", "stateful\n");
    await writeFile(join(skill, ".gitignore"), "cache/\n");
    await commitAll(dataRepo, "stateful skill");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "skills/stateful"])).exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "stateful");
    const ignored = join(installed, "cache", "state.db");
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(ignored, "unique local state\n");
    await chmod(join(installed, "SKILL.md"), 0o755);
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const before = await Promise.all([
      file(manifestPath).text(),
      file(lockPath).text(),
    ]);

    const refused = await run(["rm", "skills/stateful", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      ".agents/skills/stateful/cache/state.db",
    );
    expect(refused.stderr.toString()).toContain(
      "replace an executable-mode change",
    );
    expect(refused.stderr.toString()).toContain(
      "capshelf status skills/stateful --diff",
    );
    expect(await file(ignored).text()).toBe("unique local state\n");
    expect(
      await Promise.all([file(manifestPath).text(), file(lockPath).text()]),
    ).toEqual(before);

    expect(
      (await run(["rm", "skills/stateful", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(installed).exists()).toBe(false);
  });

  test(
    "removes a copy item when the data repo source is unreachable",
    async () => {
      for (const breakage of ["missing-clone", "orphaned-commit"] as const) {
        const project = await tempRepo(`capshelf-rm-degrade-${breakage}-`);
        const dataRepo = await tempRepo(
          `capshelf-rm-degrade-${breakage}-data-`,
        );
        const run = runInProcess(project);
        await addSkill(dataRepo, "hello", "locked\n");
        await commitAll(dataRepo, "hello");
        expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
        expect((await run(["add", "skills/hello"])).exitCode).toBe(0);
        const installed = join(project, ".agents", "skills", "hello");

        if (breakage === "missing-clone") {
          const localPath = join(project, ".capshelf", "local.json");
          const local = await file(localPath).json();
          local.dataRepo = join(project, "no-such-data-repo");
          await writeFile(localPath, `${JSON.stringify(local, null, 2)}\n`);
        } else {
          const lockPath = join(project, ".capshelf", "capshelf.lock.json");
          const lock = await file(lockPath).json();
          lock.items["data/skills/hello"].sourceCommit = "0".repeat(40);
          await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        }

        // Removing a copy item is a project-only deletion. Degrading to "every
        // installed path is local state" keeps the user consenting to the full
        // list instead of stranding the item in exactly the situations — a
        // deleted clone, a rewritten upstream — where rm is what they need.
        const refused = await run(["rm", "skills/hello", "--json"]);
        expect(refused.exitCode).toBe(3);
        expect(refused.stderr.toString()).toContain(
          ".agents/skills/hello/SKILL.md — delete a local-only path",
        );
        expect(await file(join(installed, "SKILL.md")).exists()).toBe(true);

        expect((await run(["rm", "skills/hello", "--yes"])).exitCode).toBe(0);
        expect(await file(join(installed, "SKILL.md")).exists()).toBe(false);
        const lock = await file(
          join(project, ".capshelf", "capshelf.lock.json"),
        ).json();
        expect(lock.items["data/skills/hello"]).toBeUndefined();
        const manifest = await file(
          join(project, ".capshelf", "capshelf.json"),
        ).json();
        expect(manifest.skills ?? []).not.toContain("hello");
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "lists an ignored symlink as a deletion and removes it",
    async () => {
      const project = await tempRepo("capshelf-rm-symlink-project-");
      const dataRepo = await tempRepo("capshelf-rm-symlink-data-");
      const run = runInProcess(project);
      const skill = join(dataRepo, "skills", "linked");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, ".gitignore"), "node_modules/\n");
      await writeFile(join(skill, "SKILL.md"), "locked\n");
      await commitAll(dataRepo, "linked skill");
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/linked"])).exitCode).toBe(0);
      const installed = join(project, ".agents", "skills", "linked");
      await mkdir(join(installed, "node_modules", ".bin"), { recursive: true });
      await mkdir(join(installed, "node_modules", "lib"), { recursive: true });
      await writeFile(join(installed, "node_modules", "lib", "x.js"), "mod\n");
      await symlink(
        "../lib/x.js",
        join(installed, "node_modules", ".bin", "x"),
      );

      // Refusing to *enumerate* a symlink is strictly worse than listing it:
      // planCopyDirectoryRemoval exists to say what deletion will destroy.
      const refused = await run(["rm", "skills/linked", "--json"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        ".agents/skills/linked/node_modules/.bin/x — delete a local-only path",
      );

      expect((await run(["rm", "skills/linked", "--yes"])).exitCode).toBe(0);
      expect(await file(join(installed, "SKILL.md")).exists()).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("guards fragment drift before unmerging", async () => {
    const project = await tempRepo("capshelf-rm-fragment-project-");
    const dataRepo = await tempRepo("capshelf-rm-fragment-data-");
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
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await file(lockPath).text();

    const refused = await run(["rm", "settings/theme", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain(
      "replace a managed config contribution",
    );
    // Comment loss in a strict-JSON target is repair, not consentable loss.
    expect(refused.stderr.toString()).not.toContain("remove config comments");
    expect(await file(output).text()).toContain("// local context");
    expect(await file(lockPath).text()).toBe(lockBefore);

    expect(
      (await run(["rm", "settings/theme", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(output).exists()).toBe(false);
  });

  test("guards edited subagent targets before deleting them", async () => {
    const project = await tempRepo("capshelf-rm-subagent-project-");
    const dataRepo = await tempRepo("capshelf-rm-subagent-data-");
    const run = runInProcess(project);
    const source = join(dataRepo, "subagents", "reviewer", "claude.md");
    await mkdir(join(dataRepo, "subagents", "reviewer"), { recursive: true });
    await writeFile(
      source,
      "---\nname: reviewer\ndescription: Review changes\n---\n\nReview carefully.\n",
    );
    await commitAll(dataRepo, "reviewer subagent");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);
    const output = join(project, ".claude", "agents", "reviewer.md");
    await writeFile(
      output,
      "---\nname: reviewer\ndescription: Review changes\n---\n\nLocal rules.\n",
    );

    const refused = await run(["rm", "subagents/reviewer", "--json"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("overwrite a subagent target");
    expect(await file(output).text()).toContain("Local rules");
    expect(
      (await run(["rm", "subagents/reviewer", "--yes", "--json"])).exitCode,
    ).toBe(0);
    expect(await file(output).exists()).toBe(false);
  });
});
