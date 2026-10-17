import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syncTrackedIntoDataRepo } from "../src/commands/promote-named";
import { PreconditionError } from "../src/errors";
import { lastTouchingContentCommit } from "../src/git";
import { installedPath } from "../src/installed";
import { parseItemRef } from "../src/item-ref";
import { dataKey, emptyLock } from "../src/lock";
import type { Lock, WritableLock } from "../src/lock";
import { emptyManifest } from "../src/manifest";
import {
  installsAtSkillTarget,
  itemRepoRelPath,
  listMasterItems,
  PLUGIN_MANIFEST_REL,
} from "../src/master";
import { scanUntrackedShareItems } from "../src/share-scan";
import {
  commitAll,
  rejection,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { currentPinDigest } from "./pin-fixtures";

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

  // promote's required-file check sent every non-skill kind down the
  // `index.ts` branch, so `promote plugins/<n>` always refused (spec D1).
  // Arranged at the lowest function that performs the check, the way
  // tests/promote-core.test.ts arranges a copy-directory item: the CLI add
  // flow for a plugin does not exist yet to install one end to end.
  test("promote of a plugin requires plugin.json, not index.ts", async () => {
    const dataRepo = await tempRepo("capshelf-plugin-kind-promote-data-", {
      origin: null,
    });
    const project = await tempRepo("capshelf-plugin-kind-promote-project-", {
      origin: null,
    });
    const dataItem = join(dataRepo, "plugins", "p");
    await mkdir(join(dataItem, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(dataItem, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await commitAll(dataRepo, "plugin p");

    const installed = installedPath(project, "plugins", "p");
    await mkdir(join(installed, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(installed, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    // The required-file check reads this before anything else, so deleting
    // it is enough to exercise the refusal without a full add/install flow.
    await rm(join(installed, ".claude-plugin", "plugin.json"));

    const lock: WritableLock = {
      version: 5,
      items: {
        [dataKey("plugins", "p")]: {
          source: "data",
          sourcePinDigest: await currentPinDigest(dataRepo, "plugins", "p"),
          sourceCommit: await lastTouchingContentCommit(dataRepo, "plugins/p"),
          appliedAt: "2026-10-17T00:00:00.000Z",
        },
      },
    };

    const error = await rejection(
      syncTrackedIntoDataRepo(project, dataRepo, "plugins", "p", lock, {}),
      PreconditionError,
    );
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain(PLUGIN_MANIFEST_REL);
    expect(error.message).not.toContain("index.ts");
  });

  // `show` hid every nested file for a copy-directory item unless its kind
  // was pi-extensions, so `show plugins/<n>` printed only its top-level
  // files and silently dropped everything a real plugin holds below
  // `hooks/`, `skills/`, and the rest.
  test("show plugins/<n> lists nested files", async () => {
    const project = await tempRepo("capshelf-plugin-kind-show-project-");
    const dataRepo = await tempRepo("capshelf-plugin-kind-show-data-");
    const pluginDir = join(dataRepo, "plugins", "p");
    await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );
    await mkdir(join(pluginDir, "hooks"), { recursive: true });
    await writeFile(join(pluginDir, "hooks", "hooks.json"), "{}\n");
    await commitAll(dataRepo, "plugin p");

    const run = runInProcess(project);
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const shown = await run(["show", "plugins/p"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout.toString()).toContain("─── hooks/hooks.json");
  });

  // The share scanner walked every directory under the shared skill-target
  // folder (spec D2) and treated each as an untracked skill, with no check
  // for a lock entry recorded as `plugins/<n>` at that same folder — so an
  // installed, tracked plugin showed up in the share picker as if it were
  // an unmanaged skill.
  test("the share picker does not list an installed plugin as an untracked skill", async () => {
    const project = await tempDir("capshelf-plugin-kind-scan-project-");
    const dataRepo = await tempDir("capshelf-plugin-kind-scan-data-");
    const manifest = emptyManifest();

    const installedPlugin = installedPath(
      project,
      "plugins",
      "p",
      manifest.installMode,
    );
    await mkdir(join(installedPlugin, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(installedPlugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p" }),
    );

    // A control: a real untracked skill at the same shared folder must still
    // show up, so the fix is narrow rather than hiding every skills row.
    const untrackedSkill = installedPath(
      project,
      "skills",
      "untracked",
      manifest.installMode,
    );
    await mkdir(untrackedSkill, { recursive: true });
    await writeFile(
      join(untrackedSkill, "SKILL.md"),
      "---\nname: untracked\ndescription: d\n---\nbody\n",
    );

    const projectLock: Lock = {
      version: 5,
      items: {
        [dataKey("plugins", "p")]: {
          source: "data",
          sourcePinDigest: "a".repeat(64),
          sourceCommit: "c".repeat(40),
          appliedAt: "2026-10-17T00:00:00.000Z",
        },
      },
    };

    const scan = await scanUntrackedShareItems({
      project,
      dataRepo,
      manifest,
      projectLock,
      localLock: emptyLock(),
    });

    expect(
      scan.rows.some((row) => row.kind === "skills" && row.name === "p"),
    ).toBe(false);
    expect(
      scan.rows.some(
        (row) => row.kind === "skills" && row.name === "untracked",
      ),
    ).toBe(true);
  });
});
