import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashNamedContents } from "../src/content-hash";
import {
  addSkill,
  commitAll,
  readJsonObject,
  runIn,
  stringField,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

describe("set-data legacy lock verification", () => {
  test("refuses a clone whose content does not hash to the v3 lock sha", async () => {
    const project = await tempRepo("capshelf-set-data-legacy-project-");
    const originalRepo = await tempRepo("capshelf-set-data-legacy-original-");
    const clone = join(
      await tempDir("capshelf-set-data-legacy-clone-"),
      "clone",
    );
    const run = runIn(project);

    await addSkill(originalRepo, "greet", "hi\n");
    await commitAll(originalRepo, "greet");
    const commit = (
      await $`git -C ${originalRepo} rev-parse HEAD`.text()
    ).trim();
    const lockedSha = hashNamedContents([
      { name: "SKILL.md", content: "older\n" },
    ]);
    const actualSha = hashNamedContents([
      { name: "SKILL.md", content: "hi\n" },
    ]);

    expect(run(["init", "--data", originalRepo]).exitCode).toBe(0);
    await $`git clone -q ${originalRepo} ${clone}`.quiet();
    const manifest = await readJsonObject(
      join(project, ".capshelf", "capshelf.json"),
    );
    const upstream = stringField(manifest, "dataRepoUpstream");
    await $`git -C ${clone} remote set-url origin ${upstream}`.quiet();
    await writeFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      `${JSON.stringify({
        version: 3,
        items: {
          "data/skills/greet": {
            source: "data",
            sha: lockedSha,
            sourceCommit: commit,
            appliedAt: "2026-07-02T00:00:00.000Z",
            needs: null,
            needsSourceCommit: null,
          },
        },
      })}\n`,
    );
    const localConfigPath = join(project, ".capshelf", "local.json");
    const originalLocalConfig = await readFile(localConfigPath, "utf-8");

    const result = run(["set-data", clone]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `source skills/greet at ${commit} hashes to ${actualSha}, but lock expects ${lockedSha}`,
    );
    expect(await readFile(localConfigPath, "utf-8")).toBe(originalLocalConfig);
  });
});
