import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  gitInfoExcludePath,
  lastTouchingContentCommit,
  statusPorcelain,
} from "../src/git";
import { findProjectRoot } from "../src/paths";
import { adoptIntoDataRepo } from "../src/data-repo-adopt";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  runIn,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

function executable(path: string): boolean {
  return (lstatSync(path).mode & 0o111) !== 0;
}

describe("project recovery", () => {
  test(
    "legacy root projects dispatch diagnostics and set-data migrates them",
    async () => {
      const oldData = await baselineRepo("capshelf-legacy-old-data-");
      const newData = await baselineRepo("capshelf-legacy-new-data-");
      const project = await tempDir("capshelf-legacy-project-");
      await writeFile(
        join(project, "capshelf.json"),
        `${JSON.stringify({ dataRepo: oldData, skills: [] }, null, 2)}\n`,
      );
      expect(findProjectRoot(project)).toBe(project);
      const run = runIn(project);
      const status = run(["status"]);
      expect(status.exitCode).not.toBe(0);
      expect(status.stderr.toString()).toContain("legacy dataRepo field");

      const rebound = run(["set-data", newData]);
      expect(rebound.exitCode).toBe(0);
      expect(existsSync(join(project, "capshelf.json"))).toBe(false);
      const manifest = await file(
        join(project, ".capshelf", "capshelf.json"),
      ).json();
      expect(manifest.dataRepo).toBeUndefined();
      const local = await file(join(project, ".capshelf", "local.json")).json();
      expect(local.dataRepo).toBe(newData);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("failed adoption restores the canonical path and index, then retries", async () => {
    const dataRepo = await baselineRepo("capshelf-adopt-rollback-data-");
    const project = await tempRepo("capshelf-adopt-rollback-project-", {
      origin: null,
    });
    const installed = join(project, ".agents", "skills", "newskill");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "new skill\n");
    const hook = join(dataRepo, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);
    const indexBefore = await readFile(join(dataRepo, ".git", "index"));

    await expect(
      adoptIntoDataRepo(project, dataRepo, "skills", "newskill", {
        installMode: "codex-compatible",
      }),
    ).rejects.toThrow();
    expect(existsSync(join(dataRepo, "skills", "newskill"))).toBe(false);
    expect(await readFile(join(dataRepo, ".git", "index"))).toEqual(
      indexBefore,
    );
    expect((await statusPorcelain(dataRepo)).trim()).toBe("");

    await rm(hook);
    const retried = await adoptIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "newskill",
      { installMode: "codex-compatible" },
    );
    expect(retried.action).toBe("created");

    const noIdentity = join(project, ".agents", "skills", "no-identity");
    await mkdir(noIdentity, { recursive: true });
    await writeFile(join(noIdentity, "SKILL.md"), "no identity\n");
    await $`git -C ${dataRepo} config user.name ""`.quiet();
    await $`git -C ${dataRepo} config user.email ""`.quiet();
    await $`git -C ${dataRepo} config user.useConfigOnly true`.quiet();
    const identityIndex = await readFile(join(dataRepo, ".git", "index"));
    const identityVariables = [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ] as const;
    const inheritedIdentity = new Map(
      identityVariables.map((name) => [name, process.env[name]] as const),
    );
    for (const name of identityVariables) process.env[name] = "";
    try {
      await expect(
        adoptIntoDataRepo(project, dataRepo, "skills", "no-identity", {
          installMode: "codex-compatible",
        }),
      ).rejects.toThrow();
    } finally {
      for (const [name, value] of inheritedIdentity) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(existsSync(join(dataRepo, "skills", "no-identity"))).toBe(false);
    expect(await readFile(join(dataRepo, ".git", "index"))).toEqual(
      identityIndex,
    );
  });

  test(
    "add adopts an exact interrupted-share install and refuses a mismatch",
    async () => {
      const dataRepo = await baselineRepo("capshelf-add-recovery-data-");
      const source = await addSkill(dataRepo, "recover", "recover exact\n");
      await chmod(join(source, "SKILL.md"), 0o755);
      await commitAll(dataRepo, "shared source");
      const sourceCommit = await lastTouchingContentCommit(
        dataRepo,
        "skills/recover",
      );

      for (const mismatch of [false, true]) {
        const project = await tempRepo(
          `capshelf-add-recovery-${mismatch ? "bad" : "exact"}-`,
          { origin: null },
        );
        const run = runIn(project);
        expect(
          run(["init", "--data", dataRepo, "--no-upstream"]).exitCode,
        ).toBe(0);
        const installed = join(project, ".agents", "skills", "recover");
        await mkdir(installed, { recursive: true });
        await writeFile(
          join(installed, "SKILL.md"),
          mismatch ? "different\n" : "recover exact\n",
        );
        await chmod(join(installed, "SKILL.md"), 0o755);
        const manifestPath = join(project, ".capshelf", "capshelf.json");
        const lockPath = join(project, ".capshelf", "capshelf.lock.json");
        const before = await Promise.all([
          readFile(manifestPath),
          readFile(lockPath),
        ]);
        const result = run(["add", "skills/recover"]);
        if (mismatch) {
          expect(result.exitCode).toBe(3);
          expect(await readFile(manifestPath)).toEqual(before[0]);
          expect(await readFile(lockPath)).toEqual(before[1]);
        } else {
          expect(result.exitCode).toBe(0);
          const lock = await file(lockPath).json();
          expect(lock.items["data/skills/recover"].sourceCommit).toBe(
            sourceCommit,
          );
          expect(await file(join(installed, "SKILL.md")).text()).toBe(
            "recover exact\n",
          );
          expect(executable(join(installed, "SKILL.md"))).toBe(true);
        }
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "re-running init preserves clone-local selections and state",
    async () => {
      const dataRepo = await baselineRepo("capshelf-reinit-data-");
      await addSkill(dataRepo, "local-skill");
      const extension = join(dataRepo, "pi", "extensions", "local-extension");
      await mkdir(extension, { recursive: true });
      await writeFile(join(extension, "index.ts"), "export default {};\n");
      await commitAll(dataRepo, "local skill");
      const project = await tempRepo("capshelf-reinit-project-", {
        origin: null,
      });
      const run = runIn(project);
      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      expect(run(["add", "skills/local-skill", "--local"]).exitCode).toBe(0);
      expect(
        run(["add", "pi-extensions/local-extension", "--local"]).exitCode,
      ).toBe(0);
      const excludePath = await gitInfoExcludePath(project);
      if (excludePath === null) throw new Error("expected Git exclude path");
      const paths = [
        join(project, ".capshelf", "local.json"),
        join(project, ".capshelf", "local.lock.json"),
        excludePath,
        join(project, ".agents", "skills", "local-skill", "SKILL.md"),
        join(project, ".pi", "extensions", "local-extension", "index.ts"),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path)));

      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      const after = await Promise.all(paths.map((path) => readFile(path)));
      expect(after).toEqual(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
