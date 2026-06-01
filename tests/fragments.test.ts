import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataKey, emptyLock } from "../src/lock";
import { emptyManifest } from "../src/manifest";
import {
  applyFragmentOutput,
  fragmentContributionState,
  lastTouchingFragmentCommit,
  lockedFragmentTargetsForItem,
  shaOfFragmentItem,
} from "../src/fragments";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(): Promise<string> {
  const repo = await tempDir("capshelf-fragments-repo-");
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("fragment output planning", () => {
  test("rejects missing locked source commits for fragment outputs", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    const manifest = {
      ...emptyManifest(),
      dataRepoUpstream: "https://github.com/example/shared-capshelf-data",
      settings: ["security"],
    };
    const lock = emptyLock();
    const entry = {
      source: "data" as const,
      sha: "locked",
      sourceCommit: "abc123",
      appliedAt: new Date().toISOString(),
    };
    lock.items[dataKey("settings", "security")] = entry;

    await expect(
      lockedFragmentTargetsForItem(
        dataRepo,
        "settings",
        "security",
        entry,
        manifest,
      ),
    ).rejects.toThrow(
      /current dataRepoUpstream: https:\/\/github.com\/example\/shared-capshelf-data/,
    );
    await expect(
      fragmentContributionState(
        project,
        dataRepo,
        manifest,
        lock,
        "claude-settings",
      ),
    ).rejects.toThrow(/does not contain commit abc123/);
  });

  test("rejects unmanaged scalar collision without writing output", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    await mkdir(join(dataRepo, "settings", "theme"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme");
    const sourceCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const sha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    const manifest = { ...emptyManifest(), settings: ["theme"] };
    const oldLock = emptyLock();
    const nextLock = emptyLock();
    nextLock.items[dataKey("settings", "theme")] = {
      source: "data",
      sha,
      sourceCommit,
      appliedAt: new Date().toISOString(),
    };

    const settingsPath = join(project, ".claude", "settings.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ theme: "light" }));

    await expect(
      applyFragmentOutput({
        project,
        dataRepo,
        manifest,
        oldLock,
        nextLock,
        target: "claude-settings",
      }),
    ).rejects.toThrow("would overwrite unmanaged local value at theme");
    expect(await file(settingsPath).text()).toBe('{"theme":"light"}');
  });

  test("restores drift on paths owned by the old managed contribution", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    const fragment = join(dataRepo, "settings", "theme");
    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme v1");
    const v1Commit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const v1Sha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    await writeFile(
      join(fragment, "settings.json"),
      JSON.stringify({ theme: "light" }),
    );
    await commitAll(dataRepo, "theme v2");
    const v2Commit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const v2Sha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    const manifest = { ...emptyManifest(), settings: ["theme"] };
    const oldLock = emptyLock();
    oldLock.items[dataKey("settings", "theme")] = {
      source: "data",
      sha: v1Sha,
      sourceCommit: v1Commit,
      appliedAt: new Date().toISOString(),
    };
    const nextLock = emptyLock();
    nextLock.items[dataKey("settings", "theme")] = {
      source: "data",
      sha: v2Sha,
      sourceCommit: v2Commit,
      appliedAt: new Date().toISOString(),
    };
    const settingsPath = join(project, ".claude", "settings.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ theme: "drifted" }));

    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock,
      target: "claude-settings",
    });

    const applied = JSON.parse(await file(settingsPath).text());
    expect(applied.theme).toBe("light");
  });

  test("removes output when only managed settings remain", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    await mkdir(join(dataRepo, "settings", "theme"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme");
    const sourceCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "settings",
      "theme",
    );
    const sha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    const oldManifest = { ...emptyManifest(), settings: ["theme"] };
    const nextManifest = emptyManifest();
    const oldLock = emptyLock();
    oldLock.items[dataKey("settings", "theme")] = {
      source: "data",
      sha,
      sourceCommit,
      appliedAt: new Date().toISOString(),
    };
    const nextLock = emptyLock();
    const settingsPath = join(project, ".claude", "settings.json");
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        $schema: "https://json.schemastore.org/claude-code-settings.json",
        theme: "dark",
      }),
    );

    await applyFragmentOutput({
      project,
      dataRepo,
      manifest: nextManifest,
      oldManifest,
      nextManifest,
      oldLock,
      nextLock,
      target: "claude-settings",
    });

    expect(existsSync(settingsPath)).toBe(false);
  });

  test("merges multi-target mcp and codex config fragments", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await mkdir(join(dataRepo, "codex", "config", "defaults"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "mcp", "github", "claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "github-mcp" } } }),
    );
    await writeFile(
      join(dataRepo, "mcp", "github", "codex.toml"),
      '[mcp_servers.github]\ncommand = "github-mcp"\nenabled = true\n',
    );
    await writeFile(
      join(dataRepo, "codex", "config", "defaults", "config.toml"),
      'model = "gpt-5"\nsandbox = "workspace-write"\n',
    );
    await commitAll(dataRepo, "fragments");
    const mcpCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "mcp",
      "github",
    );
    const mcpSha = await shaOfFragmentItem(dataRepo, "mcp", "github");
    const codexCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "codex-config",
      "defaults",
    );
    const codexSha = await shaOfFragmentItem(
      dataRepo,
      "codex-config",
      "defaults",
    );
    const manifest = {
      ...emptyManifest(),
      mcp: ["github"],
      codexConfig: ["defaults"],
    };
    const lock = emptyLock();
    lock.items[dataKey("mcp", "github")] = {
      source: "data",
      sha: mcpSha,
      sourceCommit: mcpCommit,
      appliedAt: new Date().toISOString(),
    };
    lock.items[dataKey("codex-config", "defaults")] = {
      source: "data",
      sha: codexSha,
      sourceCommit: codexCommit,
      appliedAt: new Date().toISOString(),
    };

    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock: emptyLock(),
      nextLock: lock,
      target: "claude-mcp",
    });
    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock: emptyLock(),
      nextLock: lock,
      target: "codex-config",
    });

    const claudeMcp = JSON.parse(await file(join(project, ".mcp.json")).text());
    expect(claudeMcp.mcpServers.github.command).toBe("github-mcp");
    const codexConfig = Bun.TOML.parse(
      await file(join(project, ".codex", "config.toml")).text(),
    ) as { model?: string; mcp_servers?: { github?: { enabled?: boolean } } };
    expect(codexConfig.model).toBe("gpt-5");
    expect(codexConfig.mcp_servers?.github?.enabled).toBe(true);
    expect(
      await fragmentContributionState(
        project,
        dataRepo,
        manifest,
        lock,
        "codex-config",
      ),
    ).toBe("ok");
  });
});
