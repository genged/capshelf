import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  shaOfFragmentItemAtCommit,
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

describe("fragmentContributionState", () => {
  interface StateFixture {
    dataRepo: string;
    project: string;
    manifest: ReturnType<typeof emptyManifest>;
    lock: ReturnType<typeof emptyLock>;
    outputPath: string;
  }

  // A claude-mcp fragment exercising nested objects (env) and arrays (args).
  const managedFragment = {
    mcpServers: {
      github: {
        command: "github-mcp",
        args: ["--scope", "repo"],
        env: { GITHUB_HOST: "github.com" },
      },
    },
  };

  async function appliedMcpFixture(): Promise<StateFixture> {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-fragments-project-");
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "github", "claude.json"),
      JSON.stringify(managedFragment),
    );
    await commitAll(dataRepo, "github mcp");
    const sourceCommit = await lastTouchingFragmentCommit(
      dataRepo,
      "mcp",
      "github",
    );
    const sha = await shaOfFragmentItem(dataRepo, "mcp", "github");
    const manifest = { ...emptyManifest(), mcp: ["github"] };
    const lock = emptyLock();
    lock.items[dataKey("mcp", "github")] = {
      source: "data",
      sha,
      sourceCommit,
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
    return {
      dataRepo,
      project,
      manifest,
      lock,
      outputPath: join(project, ".mcp.json"),
    };
  }

  function state(fixture: StateFixture) {
    return fragmentContributionState(
      fixture.project,
      fixture.dataRepo,
      fixture.manifest,
      fixture.lock,
      "claude-mcp",
    );
  }

  test("reports ok right after apply and missing once the output is deleted", async () => {
    const fixture = await appliedMcpFixture();
    expect(await state(fixture)).toBe("ok");

    await rm(fixture.outputPath);
    expect(await state(fixture)).toBe("missing");
  });

  test("reports drifted when a managed scalar is altered", async () => {
    const fixture = await appliedMcpFixture();
    const current = JSON.parse(await file(fixture.outputPath).text());
    current.mcpServers.github.command = "evil-mcp";
    await writeFile(fixture.outputPath, JSON.stringify(current));

    expect(await state(fixture)).toBe("drifted");
  });

  test("reports drifted when a managed nested key is removed", async () => {
    const fixture = await appliedMcpFixture();
    const current = JSON.parse(await file(fixture.outputPath).text());
    delete current.mcpServers.github.env.GITHUB_HOST;
    await writeFile(fixture.outputPath, JSON.stringify(current));

    expect(await state(fixture)).toBe("drifted");
  });

  test("reports drifted when a managed array entry is removed", async () => {
    const fixture = await appliedMcpFixture();
    const current = JSON.parse(await file(fixture.outputPath).text());
    current.mcpServers.github.args = ["--scope"];
    await writeFile(fixture.outputPath, JSON.stringify(current));

    expect(await state(fixture)).toBe("drifted");
  });

  test("stays ok with extra unmanaged keys alongside intact managed keys", async () => {
    const fixture = await appliedMcpFixture();
    const current = JSON.parse(await file(fixture.outputPath).text());
    current.localOnly = { note: "user-owned" };
    current.mcpServers.linear = { command: "linear-mcp" };
    current.mcpServers.github.env.USER_EXTRA = "1";
    await writeFile(fixture.outputPath, JSON.stringify(current));

    expect(await state(fixture)).toBe("ok");
  });

  test("stays ok when managed array entries sit among extra user entries", async () => {
    const fixture = await appliedMcpFixture();
    const current = JSON.parse(await file(fixture.outputPath).text());
    // Reordered and interleaved with user-added flags: managed entries are
    // matched as a subset, not positionally.
    current.mcpServers.github.args = [
      "--verbose",
      "repo",
      "--user-flag",
      "--scope",
    ];
    await writeFile(fixture.outputPath, JSON.stringify(current));

    expect(await state(fixture)).toBe("ok");
  });
});

describe("shaOfFragmentItemAtCommit", () => {
  test("matches shaOfFragmentItem on a clean tree and diverges after dirty edits", async () => {
    const dataRepo = await tempRepo();
    await mkdir(join(dataRepo, "settings", "theme"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    await commitAll(dataRepo, "theme v1");

    const worktreeSha = await shaOfFragmentItem(dataRepo, "settings", "theme");
    const headSha = await shaOfFragmentItemAtCommit(
      dataRepo,
      "settings",
      "theme",
      "HEAD",
    );
    expect(headSha).toBe(worktreeSha);

    // Dirty worktree edit: the worktree sha moves, the HEAD sha does not.
    await writeFile(
      join(dataRepo, "settings", "theme", "settings.json"),
      JSON.stringify({ theme: "light" }),
    );
    expect(await shaOfFragmentItem(dataRepo, "settings", "theme")).not.toBe(
      worktreeSha,
    );
    expect(
      await shaOfFragmentItemAtCommit(dataRepo, "settings", "theme", "HEAD"),
    ).toBe(worktreeSha);
  });

  test("still sees a canonical file that exists at HEAD but was deleted in the worktree", async () => {
    const dataRepo = await tempRepo();
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "github", "claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "github-mcp" } } }),
    );
    await writeFile(
      join(dataRepo, "mcp", "github", "codex.toml"),
      '[mcp_servers.github]\ncommand = "github-mcp"\n',
    );
    await commitAll(dataRepo, "github mcp");
    const committedSha = await shaOfFragmentItem(dataRepo, "mcp", "github");

    // Dirty-delete one canonical file: the worktree-existsSync trap would
    // drop it from the hash; the HEAD-committed hash must keep it.
    await rm(join(dataRepo, "mcp", "github", "codex.toml"));
    expect(
      await shaOfFragmentItemAtCommit(dataRepo, "mcp", "github", "HEAD"),
    ).toBe(committedSha);
    expect(await shaOfFragmentItem(dataRepo, "mcp", "github")).not.toBe(
      committedSha,
    );
  });

  test("files absent at the commit participate as absent", async () => {
    const dataRepo = await tempRepo();
    await mkdir(join(dataRepo, "mcp", "github"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "github", "claude.json"),
      JSON.stringify({ mcpServers: { github: { command: "github-mcp" } } }),
    );
    await commitAll(dataRepo, "claude target only");
    const claudeOnly = await shaOfFragmentItemAtCommit(
      dataRepo,
      "mcp",
      "github",
      "HEAD",
    );
    expect(claudeOnly).toBe(await shaOfFragmentItem(dataRepo, "mcp", "github"));

    await writeFile(
      join(dataRepo, "mcp", "github", "codex.toml"),
      '[mcp_servers.github]\ncommand = "github-mcp"\n',
    );
    await commitAll(dataRepo, "add codex target");
    expect(
      await shaOfFragmentItemAtCommit(dataRepo, "mcp", "github", "HEAD"),
    ).not.toBe(claudeOnly);
    expect(
      await shaOfFragmentItemAtCommit(dataRepo, "mcp", "github", "HEAD~1"),
    ).toBe(claudeOnly);
  });
});
