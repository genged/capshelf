import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataKey, emptyLock } from "../src/lock";
import { lastTouchingCommit } from "../src/git";
import { shaOfItem } from "../src/master";
import { emptyManifest } from "../src/manifest";
import {
  applySettingsFragments,
  mergeSettingsFragments,
  settingsContributionState,
  settingsOutputPath,
} from "../src/settings";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(): Promise<string> {
  const repo = await tempDir("capshelf-settings-repo-");
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("settings fragments", () => {
  test("merge rules are deterministic", () => {
    expect(
      mergeSettingsFragments([
        {
          permissions: {
            allow: ["Bash(git status *)"],
            deny: ["Read(./.env)"],
          },
          hooks: {
            PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }],
          },
          theme: "light",
        },
        {
          permissions: {
            allow: ["Bash(git status *)", "Bash(git diff *)"],
            deny: ["Bash(curl *)"],
          },
          hooks: {
            PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "format" }] }],
          },
          theme: "dark",
        },
      ]),
    ).toEqual({
      permissions: {
        allow: ["Bash(git status *)", "Bash(git diff *)"],
        deny: ["Read(./.env)", "Bash(curl *)"],
      },
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "lint" }] },
          { matcher: "Write", hooks: [{ type: "command", command: "format" }] },
        ],
      },
      theme: "dark",
    });
  });

  test("apply overlays managed settings while preserving local project settings", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-settings-project-");
    const fragment = join(dataRepo, "settings", "security");

    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Read(./.env)", "Bash(curl *)"],
        },
      }),
    );
    await commitAll(dataRepo, "security v1");
    const v1Commit = await lastTouchingCommit(dataRepo, "settings/security");
    const v1Sha = await shaOfItem(fragment);

    const manifest = {
      ...emptyManifest(),
      settings: ["security"],
    };
    const oldLock = emptyLock();
    const nextLock = emptyLock();
    nextLock.items[dataKey("settings", "security")] = {
      source: "data",
      sha: v1Sha,
      sourceCommit: v1Commit,
      appliedAt: new Date().toISOString(),
    };

    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      settingsOutputPath(project),
      JSON.stringify({
        permissions: { allow: ["Bash(git status *)"] },
        env: { PROJECT_MODE: "dev" },
      }),
    );

    const result = await applySettingsFragments({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock,
    });

    expect(result.action).toBe("reconciled");
    const applied = JSON.parse(await file(settingsOutputPath(project)).text());
    expect(applied.permissions.allow).toEqual(["Bash(git status *)"]);
    expect(applied.permissions.deny).toEqual([
      "Read(./.env)",
      "Bash(curl *)",
    ]);
    expect(applied.env).toEqual({ PROJECT_MODE: "dev" });
    expect(applied.$schema).toBe(
      "https://json.schemastore.org/claude-code-settings.json",
    );
    expect(
      await settingsContributionState(project, dataRepo, manifest, nextLock),
    ).toBe("ok");
  });

  test("update removes old managed values and keeps local additions", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-settings-project-");
    const fragment = join(dataRepo, "settings", "security");

    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Read(./.env)", "Bash(curl *)"],
        },
      }),
    );
    await commitAll(dataRepo, "security v1");
    const v1Commit = await lastTouchingCommit(dataRepo, "settings/security");
    const v1Sha = await shaOfItem(fragment);

    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Read(./.env)", "Bash(wget *)"],
        },
      }),
    );
    await commitAll(dataRepo, "security v2");
    const v2Commit = await lastTouchingCommit(dataRepo, "settings/security");
    const v2Sha = await shaOfItem(fragment);

    const manifest = {
      ...emptyManifest(),
      settings: ["security"],
    };
    const oldLock = emptyLock();
    oldLock.items[dataKey("settings", "security")] = {
      source: "data",
      sha: v1Sha,
      sourceCommit: v1Commit,
      appliedAt: new Date().toISOString(),
    };
    const nextLock = emptyLock();
    nextLock.items[dataKey("settings", "security")] = {
      source: "data",
      sha: v2Sha,
      sourceCommit: v2Commit,
      appliedAt: new Date().toISOString(),
    };

    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      settingsOutputPath(project),
      JSON.stringify({
        permissions: {
          allow: ["Bash(git status *)"],
          deny: ["Read(./tmp/private/**)", "Read(./.env)", "Bash(curl *)"],
        },
      }),
    );

    const result = await applySettingsFragments({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock,
    });

    expect(result.action).toBe("reconciled");
    const applied = JSON.parse(await file(settingsOutputPath(project)).text());
    expect(applied.permissions.allow).toEqual(["Bash(git status *)"]);
    expect(applied.permissions.deny).toEqual([
      "Read(./tmp/private/**)",
      "Read(./.env)",
      "Bash(wget *)",
    ]);
    expect(
      await settingsContributionState(project, dataRepo, manifest, nextLock),
    ).toBe("ok");

    await writeFile(
      settingsOutputPath(project),
      JSON.stringify({ permissions: { deny: ["Read(./tmp/private/**)"] } }),
    );
    expect(
      await settingsContributionState(project, dataRepo, manifest, nextLock),
    ).toBe("drifted");
  });
});
