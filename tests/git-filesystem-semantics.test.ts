import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { currentPinDigest } from "./pin-fixtures";
import { lstatSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDataRepoRoot,
  commitInRepo,
  gitInfoExcludePath,
  sourceVisibleFilesUnderPath,
  lastTouchingContentCommit,
  statusPorcelain,
  statusPorcelainOutsidePaths,
} from "../src/git";
import { ensureLocalExcludes, removeLocalExcludes } from "../src/local-config";
import { ManifestSchema } from "../src/manifest";
import { shaOfGitVisibleItem } from "../src/master";
import { materializeLockEntry } from "../src/materialize";
import { dataKey, type Lock } from "../src/lock";
import { copyDirectoryModeDrifted } from "../src/status-diff";
import { syncTrackedIntoDataRepo } from "../src/commands/promote";
import {
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

describe("Git and filesystem semantics", () => {
  test("data bindings accept only canonical worktree-root paths", async () => {
    const repo = await baselineRepo("capshelf-root-binding-");
    const nested = join(repo, "nested");
    await mkdir(nested);
    await expect(assertDataRepoRoot(repo)).resolves.toBeUndefined();
    await expect(
      assertDataRepoRoot(join(nested, "..")),
    ).resolves.toBeUndefined();
    const linkParent = await tempDir("capshelf-root-link-");
    const link = join(linkParent, "repo");
    await symlink(repo, link, "dir");
    await expect(assertDataRepoRoot(link)).resolves.toBeUndefined();
    await expect(assertDataRepoRoot(nested)).rejects.toThrow(
      new RegExp(
        `supplied: ${nested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*worktree root`,
        "s",
      ),
    );
  });

  test("literal Git paths isolate metacharacter item names", async () => {
    const repo = await baselineRepo("capshelf-literal-paths-");
    const pairs = [
      ["a*", "abc"],
      ["q?", "qa"],
      ["[x]", "x"],
      ["right]", "rightx"],
    ] as const;
    for (const [literal, sibling] of pairs) {
      await addSkill(repo, literal, `${literal}\n`);
      await addSkill(repo, sibling, `${sibling}\n`);
    }
    await commitAll(repo, "metacharacter items");
    const original = await lastTouchingContentCommit(repo, "skills/a*");
    for (const [literal] of pairs) {
      expect(
        await sourceVisibleFilesUnderPath(repo, `skills/${literal}`),
      ).toEqual(["SKILL.md"]);
      expect(await shaOfGitVisibleItem(repo, `skills/${literal}`)).toMatch(
        /^[0-9a-f]{12}$/u,
      );
    }

    await writeFile(join(repo, "skills", "abc", "SKILL.md"), "sibling v2\n");
    await commitInRepo(repo, ["skills/abc"], "sibling only");
    expect(await lastTouchingContentCommit(repo, "skills/a*")).toBe(original);
    await writeFile(join(repo, "skills", "a*", "SKILL.md"), "literal v2\n");
    await writeFile(join(repo, "skills", "abc", "SKILL.md"), "sibling dirty\n");
    await commitInRepo(repo, ["skills/a*"], "literal only");
    expect(await statusPorcelain(repo, "skills/abc")).toContain("skills/abc");
    await commitInRepo(repo, ["skills/abc"], "finish sibling");

    const project = await tempRepo("capshelf-literal-project-", {
      origin: null,
    });
    const run = runIn(project);
    expect(run(["init", "--data", repo, "--no-upstream"]).exitCode).toBe(0);
    expect(run(["add", "skills/a*"]).exitCode).toBe(0);
    const installed = join(project, ".agents", "skills", "a*", "SKILL.md");
    await writeFile(installed, "literal promoted\n");
    expect(run(["promote", "skills/a*"]).exitCode).toBe(0);
    expect(await file(join(repo, "skills", "a*", "SKILL.md")).text()).toBe(
      "literal promoted\n",
    );
    expect(await file(join(repo, "skills", "abc", "SKILL.md")).text()).toBe(
      "sibling dirty\n",
    );
  });

  test("exclusion pathspecs isolate metacharacter item names", async () => {
    const repo = await baselineRepo("capshelf-exclude-paths-");
    // Each excluded name is a glob that would swallow its sibling if the
    // exclusion were rendered without `literal`.
    const pairs = [
      ["a*", "abc"],
      ["q?", "qa"],
      ["[ab]", "a"],
      [":(exclude)x", "x"],
    ] as const;
    for (const [literal, sibling] of pairs) {
      await addSkill(repo, literal, `${literal}\n`);
      await addSkill(repo, sibling, `${sibling}\n`);
    }
    await commitAll(repo, "metacharacter items");
    for (const [literal, sibling] of pairs) {
      for (const name of [literal, sibling]) {
        await writeFile(join(repo, "skills", name, "SKILL.md"), "dirty\n");
      }
    }

    for (const [literal, sibling] of pairs) {
      const out = await statusPorcelainOutsidePaths(repo, [
        `skills/${literal}`,
      ]);
      expect(out).not.toContain(`skills/${literal}/SKILL.md`);
      expect(out).toContain(`skills/${sibling}/SKILL.md`);
    }
  });

  test("status, promote, and apply observe executable-mode-only changes", async () => {
    const dataRepo = await baselineRepo("capshelf-mode-data-");
    const dataSkill = await addSkill(dataRepo, "mode", "mode skill\n");
    await chmod(join(dataSkill, "SKILL.md"), 0o644);
    await commitAll(dataRepo, "mode 644");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/mode",
    );
    const sha = await currentPinDigest(dataRepo, "skills", "mode");
    const consumer = await tempRepo("capshelf-mode-consumer-", {
      origin: null,
    });
    const consume = runIn(consumer);
    expect(
      consume(["init", "--data", dataRepo, "--no-upstream"]).exitCode,
    ).toBe(0);
    expect(consume(["add", "skills/mode"]).exitCode).toBe(0);
    const project = await tempRepo("capshelf-mode-project-", { origin: null });
    const installed = join(project, ".agents", "skills", "mode");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "mode skill\n");
    await chmod(join(installed, "SKILL.md"), 0o755);
    const lock: Lock = {
      version: 4,
      items: {
        [dataKey("skills", "mode")]: {
          source: "data",
          sourcePinDigest: sha,
          sourceCommit,
          appliedAt: "2026-08-03T00:00:00.000Z",
        },
      },
    };
    expect(
      await copyDirectoryModeDrifted({
        project,
        dataRepo,
        manifest: ManifestSchema.parse({}),
        kind: "skills",
        name: "mode",
        source: "data",
        sourceCommit,
      }),
    ).toBe(true);

    const promoted = await syncTrackedIntoDataRepo(
      project,
      dataRepo,
      "skills",
      "mode",
      lock,
      {},
    );
    expect(promoted.action).toBe("promoted");
    expect(executable(join(dataSkill, "SKILL.md"))).toBe(true);
    // PIN-1 puts the mode inside identity, where it used to sit outside: an
    // executable-bit flip is a real content change, so promoting one produces
    // a different pin rather than the same one with a separate mode flag.
    expect(promoted.sha).not.toBe(sha);
    expect(promoted.sha).toBe(
      await currentPinDigest(dataRepo, "skills", "mode"),
    );
    expect(consume(["update", "skills/mode"]).exitCode).toBe(0);
    expect(
      executable(join(consumer, ".agents", "skills", "mode", "SKILL.md")),
    ).toBe(true);
    const consumerLock = await file(
      join(consumer, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(consumerLock.items["data/skills/mode"].sourceCommit).not.toBe(
      sourceCommit,
    );
    const consumerInstalled = join(
      consumer,
      ".agents",
      "skills",
      "mode",
      "SKILL.md",
    );
    await chmod(consumerInstalled, 0o644);
    const refusedUpdate = consume(["update", "skills/mode"]);
    expect(refusedUpdate.exitCode).toBe(3);
    expect(refusedUpdate.stderr.toString()).toContain(
      "Update would destroy local state",
    );
    expect(executable(consumerInstalled)).toBe(false);
    expect(consume(["update", "skills/mode", "--yes"]).exitCode).toBe(0);
    expect(executable(consumerInstalled)).toBe(true);

    const entry = lock.items[dataKey("skills", "mode")];
    if (entry?.source !== "data") throw new Error("expected data lock");
    await chmod(join(installed, "SKILL.md"), 0o644);
    expect(
      await copyDirectoryModeDrifted({
        project,
        dataRepo,
        manifest: ManifestSchema.parse({}),
        kind: "skills",
        name: "mode",
        source: "data",
        sourceCommit: entry.sourceCommit,
      }),
    ).toBe(true);
    const applied = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "mode"),
      entry,
      scope: "project",
    });
    expect(applied.action).toBe("reconciled");
    expect(executable(join(installed, "SKILL.md"))).toBe(true);
    expect(await currentPinDigest(dataRepo, "skills", "mode")).toBe(
      promoted.sha,
    );
  });

  test("linked worktrees remove entries from the resolved exclude file", async () => {
    const main = await baselineRepo("capshelf-linked-main-");
    const parent = await tempDir("capshelf-linked-parent-");
    const linked = join(parent, "linked");
    await $`git -C ${main} worktree add -q -b linked-test ${linked}`.quiet();
    const installed = join(linked, ".agents", "skills", "draft");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "draft\n");
    await ensureLocalExcludes(linked, "skills", "draft");
    const excludePath = await gitInfoExcludePath(linked);
    if (excludePath === null) throw new Error("expected linked exclude path");
    expect(await file(excludePath).text()).toContain(".agents/skills/draft/");
    expect((await statusPorcelain(linked)).trim()).toBe("");

    await removeLocalExcludes(linked, "skills", "draft");
    expect(await file(excludePath).text()).not.toContain(
      ".agents/skills/draft/",
    );
    expect(await file(excludePath).text()).toMatch(/\n$/u);
    expect(await statusPorcelain(linked)).toContain(".agents/");
  });
});
