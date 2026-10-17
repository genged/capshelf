import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installedPath } from "../src/installed";
import {
  installsAtSkillTarget,
  itemRepoRelPath,
  listMasterItems,
} from "../src/master";
import { parseItemRef } from "../src/item-ref";
import { commitAll, runInProcess, tempDir, tempRepo } from "./cli-fixtures";

async function writePlugin(
  repo: string,
  dir: string,
  manifestName: string | null,
): Promise<void> {
  await mkdir(join(repo, "plugins", dir, "skills", "s"), { recursive: true });
  await writeFile(
    join(repo, "plugins", dir, "skills", "s", "SKILL.md"),
    "---\nname: s\ndescription: d\n---\nbody\n",
  );
  if (manifestName !== null) {
    await mkdir(join(repo, "plugins", dir, ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(repo, "plugins", dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: manifestName }),
    );
  }
}

describe("plugins kind", () => {
  test("the data repo path is plugins/<name>", () => {
    expect(itemRepoRelPath("plugins", "gh-cli")).toBe("plugins/gh-cli");
  });

  test("plugins and skills share the install target", async () => {
    const project = await tempDir("capshelf-plugin-kind-");
    expect(installedPath(project, "plugins", "x", "codex-compatible")).toBe(
      installedPath(project, "skills", "x", "codex-compatible"),
    );
    expect(installedPath(project, "plugins", "x", "claude-only")).toBe(
      installedPath(project, "skills", "x", "claude-only"),
    );
  });

  test("installsAtSkillTarget is true for skills and plugins only", () => {
    expect(installsAtSkillTarget("skills")).toBe(true);
    expect(installsAtSkillTarget("plugins")).toBe(true);
    expect(installsAtSkillTarget("pi-extensions")).toBe(false);
  });

  test("a plugins directory is an item only with a matching manifest", async () => {
    const repo = await tempRepo("capshelf-plugin-kind-data-", {
      origin: null,
    });
    await writePlugin(repo, "good", "good");
    await writePlugin(repo, "nomanifest", null);
    await writePlugin(repo, "rr", "rust-review");
    await commitAll(repo, "plugins");
    const names = (await listMasterItems(repo, "plugins")).map((i) => i.name);
    expect(names).toEqual(["good"]);
  });

  test("plugins/<n> parses as a ref", () => {
    expect(parseItemRef("plugins/gh-cli")).toEqual({
      kind: "plugins",
      name: "gh-cli",
    });
  });

  test("ls warns when a plugin directory's manifest names it differently", async () => {
    const project = await tempRepo("capshelf-plugin-kind-project-");
    const dataRepo = await tempRepo("capshelf-plugin-kind-ls-data-");
    await writePlugin(dataRepo, "rr", "rust-review");
    await commitAll(dataRepo, "plugins");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const human = await run(["ls"]);
    expect(human.exitCode).toBe(0);
    expect(human.stderr.toString()).toContain(
      '⚠ plugins/rr is not listed: its plugin.json names it "rust-review". Rename the directory to plugins/rust-review.',
    );

    const jsonResult = await run(["ls", "--json"]);
    expect(jsonResult.exitCode).toBe(0);
    const parsed = JSON.parse(jsonResult.stdout.toString());
    expect(parsed.warnings).toEqual([
      {
        path: "plugins/rr",
        message:
          'is not listed: its plugin.json names it "rust-review". Rename the directory to plugins/rust-review.',
      },
    ]);
  });
});
