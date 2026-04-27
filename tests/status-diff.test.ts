import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataKey } from "../src/lock";
import { lastTouchingCommit } from "../src/git";
import { shaOfGitVisibleItem } from "../src/master";
import {
  buildStatusDiff,
  shouldShowLocalDiff,
  unifiedDiff,
} from "../src/status-diff";

async function tempRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("status diff helpers", () => {
  test("selects local drift states only", () => {
    expect(shouldShowLocalDiff("drifted_local")).toBe(true);
    expect(shouldShowLocalDiff("drifted_and_update")).toBe(true);
    expect(shouldShowLocalDiff("missing_installed")).toBe(true);
    expect(shouldShowLocalDiff("drifted_and_upstream_dirty")).toBe(true);
    expect(shouldShowLocalDiff("update_available")).toBe(false);
    expect(shouldShowLocalDiff("ok")).toBe(false);
    expect(shouldShowLocalDiff("kept-local")).toBe(false);
  });

  test("renders git-style context-limited unified diffs", async () => {
    const current = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const locked = [...current];
    locked[9] = "changed line 10";

    const diff = await unifiedDiff(
      "current",
      "locked",
      `${current.join("\n")}\n`,
      `${locked.join("\n")}\n`,
    );

    expect(diff).toContain("--- current");
    expect(diff).toContain("+++ locked");
    expect(diff).toContain("-line 10");
    expect(diff).toContain("+changed line 10");
    expect(diff).toContain(" line 7");
    expect(diff).toContain(" line 13");
    expect(diff.split("\n")).not.toContain(" line 1");
    expect(diff.split("\n")).not.toContain(" line 20");
  });

  test("reports missing git before rendering diffs", async () => {
    const oldPath = process.env.PATH;
    const emptyPath = await mkdtemp(join(tmpdir(), "capshelf-empty-path-"));
    process.env.PATH = emptyPath;
    try {
      await expect(unifiedDiff("current", "locked", "a\n", "b\n")).rejects.toThrow(
        /git is required but was not found on PATH/,
      );
    } finally {
      process.env.PATH = oldPath;
    }
  });

  test("buildStatusDiff compares local data-item drift against locked sourceCommit", async () => {
    const dataRepo = await tempRepo("capshelf-status-data-");
    const project = await tempRepo("capshelf-status-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "locked v1\n");
    await writeFile(join(dataItem, "deleted.md"), "locked delete\n");
    await commitAll(dataRepo, "hello v1");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const lockedSha = await shaOfGitVisibleItem(dataRepo, "skills/hello");

    await writeFile(join(dataItem, "SKILL.md"), "upstream v2\n");
    await writeFile(join(dataItem, "deleted.md"), "upstream delete\n");
    await commitAll(dataRepo, "hello v2");

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local edit\n");
    await writeFile(join(installed, "deleted.md"), "local before delete\n");
    await rm(join(installed, "deleted.md"));
    await writeFile(join(installed, "extra.md"), "local add\n");

    const diff = await buildStatusDiff({
      project,
      dataRepo,
      manifest: {
        installMode: "codex-compatible",
        skills: ["hello"],
        settings: [],
        mcp: [],
      },
      lock: {
        version: 2,
        items: {
          [dataKey("skills", "hello")]: {
            source: "data",
            sha: lockedSha,
            sourceCommit,
            appliedAt: "2026-05-08T00:00:00.000Z",
          },
        },
      },
      row: {
        source: "data",
        kind: "skills",
        name: "hello",
        state: "drifted_local",
        sourceCommit,
      },
    });

    expect(diff?.item).toBe("data/skills/hello");
    expect(diff?.path).toBe(installed);
    expect(diff?.text).toContain("--- SKILL.md (current)");
    expect(diff?.text).toContain("+++ SKILL.md (locked data/skills/hello)");
    expect(diff?.text).toContain("-local edit");
    expect(diff?.text).toContain("+locked v1");
    expect(diff?.text).toContain("+locked delete");
    expect(diff?.text).toContain("-local add");
    expect(diff?.text).not.toContain("upstream v2");
    expect(diff?.text).not.toContain("upstream delete");

    expect(await file(join(installed, "extra.md")).text()).toBe("local add\n");
  });

  test("buildStatusDiff compares settings drift against merged locked output", async () => {
    const dataRepo = await tempRepo("capshelf-status-settings-data-");
    const project = await tempRepo("capshelf-status-settings-project-");
    const fragment = join(dataRepo, "settings", "security");
    const settingsPath = join(project, ".claude", "settings.json");

    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } }) + "\n",
    );
    await commitAll(dataRepo, "security settings");
    const sourceCommit = await lastTouchingCommit(dataRepo, "settings/security");
    const lockedSha = await shaOfGitVisibleItem(dataRepo, "settings/security");

    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } }) + "\n",
    );

    const diff = await buildStatusDiff({
      project,
      dataRepo,
      manifest: {
        installMode: "codex-compatible",
        skills: [],
        settings: ["security"],
        mcp: [],
      },
      lock: {
        version: 2,
        items: {
          [dataKey("settings", "security")]: {
            source: "data",
            sha: lockedSha,
            sourceCommit,
            appliedAt: "2026-05-08T00:00:00.000Z",
          },
        },
      },
      row: {
        source: "data",
        kind: "settings",
        name: "security",
        state: "drifted_local",
        sourceCommit,
      },
    });

    expect(diff?.item).toBe("data/settings/(merged)");
    expect(diff?.path).toBe(settingsPath);
    expect(diff?.text).toContain("Bash(git status *)");
    expect(diff?.text).toContain("Bash(curl *)");
  });

  test("buildStatusDiff explains when a locked data commit is absent", async () => {
    const dataRepo = await tempRepo("capshelf-status-missing-commit-data-");
    const project = await tempRepo("capshelf-status-missing-commit-project-");

    await expect(
      buildStatusDiff({
        project,
        dataRepo,
        manifest: {
          installMode: "codex-compatible",
          dataRepoUpstream: "git@github.com:mg/agent-shared.git",
          skills: ["hello"],
          settings: [],
          mcp: [],
        },
        lock: {
          version: 2,
          items: {
            [dataKey("skills", "hello")]: {
              source: "data",
              sha: "missing",
              sourceCommit: "abc123",
              appliedAt: "2026-05-08T00:00:00.000Z",
            },
          },
        },
        row: {
          source: "data",
          kind: "skills",
          name: "hello",
          state: "drifted_local",
          sourceCommit: "abc123",
        },
      }),
    ).rejects.toThrow(/current dataRepoUpstream: https:\/\/github.com\/mg\/agent-shared/);
  });
});
