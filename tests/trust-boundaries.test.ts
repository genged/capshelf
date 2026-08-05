import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeItemName } from "../src/assert";
import { isBundleRef } from "../src/bundles";
import { defaultSelfUpdateContext } from "../src/self-update";
import { gitInfoExcludePath, headSha } from "../src/git";
import { ManifestSchema } from "../src/manifest";
import { shaOfGitVisibleItem } from "../src/master";
import { materializeLockEntry } from "../src/materialize";
import { dataKey } from "../src/lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  runIn,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

describe("trust boundaries", () => {
  test("self-update uses process.execPath even for a Bun virtual argv path", () => {
    const context = defaultSelfUpdateContext([
      "/usr/local/bin/capshelf",
      "/$bunfs/root/src/cli.ts",
    ]);
    expect(context.activeExecutablePath).toBe(process.execPath);
  });

  test("copy sources reject external, internal, and directory symlinks", async () => {
    const scenarios = ["external-file", "internal-file", "external-dir"];
    for (const scenario of scenarios) {
      const repo = await baselineRepo(`capshelf-symlink-${scenario}-`);
      const skill = await addSkill(repo, "unsafe", "safe entrypoint\n");
      const external = await tempDir(`capshelf-symlink-target-${scenario}-`);
      await writeFile(join(external, "secret.txt"), "must not be copied\n");
      if (scenario === "external-file") {
        await symlink(join(external, "secret.txt"), join(skill, "linked.txt"));
      } else if (scenario === "internal-file") {
        await writeFile(join(skill, "inside.txt"), "inside\n");
        await symlink("inside.txt", join(skill, "linked.txt"));
      } else {
        await symlink(external, join(skill, "linked-dir"));
      }
      await $`git -C ${repo} add -A`.quiet();

      await expect(shaOfGitVisibleItem(repo, "skills/unsafe")).rejects.toThrow(
        /unsupported symlink.*skills\/unsafe\/linked/u,
      );
    }
  });

  test("a committed symlink is rejected before an installed target changes", async () => {
    const dataRepo = await baselineRepo("capshelf-commit-symlink-data-");
    const project = await tempDir("capshelf-commit-symlink-project-");
    const skill = await addSkill(dataRepo, "unsafe", "entrypoint\n");
    await symlink("SKILL.md", join(skill, "linked.md"));
    await commitAll(dataRepo, "unsafe symlink");
    const commit = await headSha(dataRepo);
    const installed = join(project, ".agents", "skills", "unsafe");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "original install\n");

    await expect(
      materializeLockEntry({
        project,
        dataRepo,
        key: dataKey("skills", "unsafe"),
        entry: {
          source: "data",
          sha: "not-read",
          sourceCommit: commit,
          appliedAt: "2026-08-03T00:00:00.000Z",
        },
        scope: "project",
      }),
    ).rejects.toThrow(/mode 120000.*regular files only/u);
    expect(await file(join(installed, "SKILL.md")).text()).toBe(
      "original install\n",
    );
  });

  test("all item categories and bundle refs reject C0 controls and DEL", () => {
    const invalid = [
      "evil\0x",
      "evil\tx",
      "evil\rx",
      "evil\nx",
      "evil\r\nx",
      "evil\u007fx",
    ];
    for (const name of invalid) {
      expect(isSafeItemName(name)).toBe(false);
      expect(isBundleRef(`bundles/${name}`)).toBeNull();
      for (const field of [
        "skills",
        "settings",
        "mcp",
        "codexConfig",
        "piExtensions",
        "subagents",
      ]) {
        expect(() => ManifestSchema.parse({ [field]: [name] })).toThrow();
      }
    }
  });

  test(
    "local add rejects an injected exclude line without changing state",
    async () => {
      const dataRepo = await baselineRepo("capshelf-control-data-");
      await addSkill(dataRepo, "evil\n*", "unsafe name\n");
      await commitAll(dataRepo, "unsafe catalog name");
      const project = await tempRepo("capshelf-control-project-", {
        origin: null,
      });
      const run = runIn(project);
      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      const configPath = join(project, ".capshelf", "local.json");
      const lockPath = join(project, ".capshelf", "local.lock.json");
      const excludePath = await gitInfoExcludePath(project);
      if (excludePath === null) throw new Error("expected Git exclude path");
      const before = await Promise.all([
        readFile(configPath),
        readFile(lockPath).catch(() => Buffer.from("")),
        readFile(excludePath),
      ]);

      const result = run(["add", "skills/evil\n*", "--local"]);
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(configPath)).toEqual(before[0]);
      expect(await readFile(lockPath).catch(() => Buffer.from(""))).toEqual(
        before[1],
      );
      expect(await readFile(excludePath)).toEqual(before[2]);
      expect(existsSync(join(project, ".agents", "skills", "evil\n*"))).toBe(
        false,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
