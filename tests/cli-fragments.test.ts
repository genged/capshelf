import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

describe("cli integration", () => {
  test("promote prints where the commit landed and a push hint with origin", async () => {
    const project = await tempRepo("capshelf-promote-output-project-");
    const dataRepo = await tempRepo("capshelf-promote-output-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "baseline");

    for (const args of [
      ["init", "--data", dataRepo, "--no-upstream"],
      ["add", "skills/hello"],
    ]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, ...args],
        cwd: project,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    }

    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello v2\n",
    );
    const withoutOrigin = Bun.spawnSync({
      cmd: [process.execPath, cli, "promote", "skills/hello", "-m", "v2"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(withoutOrigin.exitCode).toBe(0);
    const stdout = withoutOrigin.stdout.toString();
    expect(stdout).toContain(`committed to local data repo:\n  ${dataRepo}`);
    expect(stdout).not.toContain("to share upstream:");

    const alreadyCurrent = Bun.spawnSync({
      cmd: [process.execPath, cli, "promote", "skills/hello"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(alreadyCurrent.exitCode).toBe(0);
    expect(alreadyCurrent.stdout.toString()).not.toContain(
      "committed to local data repo:",
    );

    await $`git -C ${dataRepo} remote add origin git@github.com:mg/agent-shared.git`.quiet();
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello v3\n",
    );
    const withOrigin = Bun.spawnSync({
      cmd: [process.execPath, cli, "promote", "skills/hello", "-m", "v3"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(withOrigin.exitCode).toBe(0);
    expect(withOrigin.stdout.toString()).toContain(
      `to share upstream:\n  cd ${dataRepo}\n  git push`,
    );

    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello v4\n",
    );
    const json = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "promote",
        "skills/hello",
        "-m",
        "v4",
        "--json",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    expect(parsed.action).toBe("promoted");
    expect(parsed.dataRepo).toBe(dataRepo);
    expect(parsed.dataRepoHasOrigin).toBe(true);
  });

  test("removed promote local-to-project flag rejects before data repo writes", async () => {
    const project = await tempRepo("capshelf-promote-removed-project-");
    const dataRepo = await tempRepo("capshelf-promote-removed-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "removed"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "removed", "SKILL.md"),
      "before\n",
    );
    await commitAll(dataRepo, "removed skill");
    const originalHead = (
      await $`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);
    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/removed"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);
    await writeFile(
      join(project, ".agents", "skills", "removed", "SKILL.md"),
      "after\n",
    );

    const promote = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "promote",
        "--local",
        "skills/removed",
        "--to-project",
        "-m",
        "should not commit",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(promote.exitCode).toBe(1);
    expect(promote.stderr.toString()).toContain(
      "unknown option '--to-project'",
    );
    expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      originalHead,
    );
    expect(
      await file(join(dataRepo, "skills", "removed", "SKILL.md")).text(),
    ).toBe("before\n");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/removed"].source).toBe("data");
  });

  test("share creates project-scope mcp fragments from explicit source files", async () => {
    const project = await tempRepo("capshelf-share-mcp-project-");
    const dataRepo = await tempRepo("capshelf-share-mcp-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const source = join(project, "claude-mcp.json");
    await writeFile(
      source,
      JSON.stringify({ mcpServers: { server: { command: "server-mcp" } } }),
    );

    const rejected = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "mcp/server", "--to", "project"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr.toString()).toContain(
      "found no unmanaged server to extract",
    );
    expect(rejected.stderr.toString()).toContain(".mcp.json does not exist");

    const missingTarget = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/server",
        "--from",
        source,
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missingTarget.exitCode).toBe(3);
    expect(missingTarget.stderr.toString()).toContain("requires --target");

    const shared = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/server",
        "--target",
        "claude",
        "--from",
        source,
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shared.exitCode).toBe(0);
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.mcp).toEqual(["server"]);
    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/mcp/server"].source).toBe("data");
    expect(
      await file(join(dataRepo, "mcp", "server", "claude.json")).exists(),
    ).toBe(true);
    const output = await file(join(project, ".mcp.json")).json();
    expect(output.mcpServers.server.command).toBe("server-mcp");
  });

  test("share --pick extracts unmanaged settings values into a new fragment", async () => {
    const project = await tempRepo("capshelf-share-pick-project-");
    const dataRepo = await tempRepo("capshelf-share-pick-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "settings", "security"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "security", "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security fragment");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);
    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "settings/security"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const outputPath = join(project, ".claude", "settings.json");
    const current = await file(outputPath).json();
    current.permissions.allow = ["Bash(git status *)"];
    current.model = "opus";
    const outputText = `${JSON.stringify(current)}\n`;
    await writeFile(outputPath, outputText);

    const managedPick = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "settings/dup",
        "--pick",
        "permissions.deny",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(managedPick.exitCode).toBe(3);
    expect(managedPick.stderr.toString()).toContain(
      "already managed by settings/security",
    );
    expect(
      await file(join(dataRepo, "settings", "dup", "settings.json")).exists(),
    ).toBe(false);

    const share = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "settings/permissions",
        "--pick",
        "permissions.allow",
        "--pick",
        "model",
        "--to",
        "project",
        "-m",
        "shared allowlist",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(0);

    const fragment = await file(
      join(dataRepo, "settings", "permissions", "settings.json"),
    ).json();
    expect(fragment).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(git status *)"] },
    });
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.settings).toEqual(["security", "permissions"]);

    expect(await readFile(outputPath, "utf-8")).toBe(outputText);

    const status = Bun.spawnSync({
      cmd: [process.execPath, cli, "status", "settings/permissions", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).items[0].state).toBe("ok");
  });

  test("share --pick adopts mcp servers by bare name", async () => {
    const project = await tempRepo("capshelf-share-pick-mcp-project-");
    const dataRepo = await tempRepo("capshelf-share-pick-mcp-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await writeFile(
      join(project, ".mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp" },
          slack: { command: "slack-mcp" },
        },
      })}\n`,
    );
    await mkdir(join(project, ".codex"), { recursive: true });
    await writeFile(
      join(project, ".codex", "config.toml"),
      '[mcp_servers.linear]\ncommand = "linear-mcp"\n',
    );

    const shareClaude = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/github",
        "--pick",
        "github",
        "--target",
        "claude",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shareClaude.exitCode).toBe(0);
    const claudeFragment = await file(
      join(dataRepo, "mcp", "github", "claude.json"),
    ).json();
    expect(claudeFragment).toEqual({
      mcpServers: { github: { command: "github-mcp" } },
    });
    const mcpOutput = await file(join(project, ".mcp.json")).json();
    expect(Object.keys(mcpOutput.mcpServers).sort()).toEqual([
      "github",
      "slack",
    ]);

    const shareCodex = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/linear",
        "--pick",
        "linear",
        "--target",
        "codex",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shareCodex.exitCode).toBe(0);
    expect(
      await file(join(dataRepo, "mcp", "linear", "codex.toml")).text(),
    ).toContain("[mcp_servers.linear]");

    const missingPick = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/missing",
        "--pick",
        "missing",
        "--target",
        "claude",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missingPick.exitCode).toBe(3);
    expect(missingPick.stderr.toString()).toContain(
      "no unmanaged value at mcpServers.missing",
    );
  });

  test("share mcp with no flags defaults pick and scope and adopts every matching target", async () => {
    const project = await tempRepo("capshelf-share-auto-mcp-project-");
    const dataRepo = await tempRepo("capshelf-share-auto-mcp-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const mcpOutputText = `${JSON.stringify({
      mcpServers: {
        posthog: { command: "posthog-mcp" },
        github: { command: "github-mcp" },
        slack: { command: "slack-mcp" },
      },
    })}\n`;
    await writeFile(join(project, ".mcp.json"), mcpOutputText);
    await mkdir(join(project, ".codex"), { recursive: true });
    const codexOutputText = '[mcp_servers.posthog]\ncommand = "posthog-mcp"\n';
    await writeFile(join(project, ".codex", "config.toml"), codexOutputText);

    // Present in both outputs: one command, one commit, both source files.
    const shareBoth = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "mcp/posthog"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shareBoth.exitCode).toBe(0);
    const claudeFragment = await file(
      join(dataRepo, "mcp", "posthog", "claude.json"),
    ).json();
    expect(claudeFragment).toEqual({
      mcpServers: { posthog: { command: "posthog-mcp" } },
    });
    expect(
      await file(join(dataRepo, "mcp", "posthog", "codex.toml")).text(),
    ).toContain("[mcp_servers.posthog]");
    const commitCount =
      await $`git -C ${dataRepo} rev-list --count HEAD`.text();
    expect(commitCount.trim()).toBe("1");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.mcp).toEqual(["posthog"]);
    expect(await readFile(join(project, ".mcp.json"), "utf-8")).toBe(
      mcpOutputText,
    );
    expect(
      await readFile(join(project, ".codex", "config.toml"), "utf-8"),
    ).toBe(codexOutputText);

    // Present in one output: only that target's source file is created.
    const shareClaudeOnly = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "mcp/github"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shareClaudeOnly.exitCode).toBe(0);
    expect(
      await file(join(dataRepo, "mcp", "github", "claude.json")).exists(),
    ).toBe(true);
    expect(
      await file(join(dataRepo, "mcp", "github", "codex.toml")).exists(),
    ).toBe(false);

    // Present in no output: fails per target and lists what is available.
    const missing = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "mcp/missing"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(missing.exitCode).toBe(3);
    const missingStderr = missing.stderr.toString();
    expect(missingStderr).toContain("found no unmanaged server to extract");
    expect(missingStderr).toContain(
      ".mcp.json has no unmanaged value at mcpServers.missing (unmanaged servers: slack)",
    );
    expect(missingStderr).toContain(
      ".codex/config.toml has no unmanaged value at mcp_servers.missing",
    );

    // Already-managed servers stay protected in auto-target mode.
    const managed = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "mcp/posthog2",
        "--pick",
        "posthog",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(managed.exitCode).toBe(3);
    expect(managed.stderr.toString()).toContain(
      "already managed by mcp/posthog",
    );
  });

  test("share rejects --pick combined with --from or non-fragment items", async () => {
    const project = await tempRepo("capshelf-share-pick-reject-project-");
    const dataRepo = await tempRepo("capshelf-share-pick-reject-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const both = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "settings/security",
        "--from",
        "settings.json",
        "--pick",
        "permissions",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(both.exitCode).toBe(3);
    expect(both.stderr.toString()).toContain(
      "accepts either --from or --pick, not both",
    );

    const skillPick = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "skills/draft",
        "--pick",
        "anything",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(skillPick.exitCode).toBe(3);
    expect(skillPick.stderr.toString()).toContain(
      "--pick is only valid for fragment items",
    );
  });

  test("status preserves fragment update availability when output drifted", async () => {
    const project = await tempRepo("capshelf-status-fragment-update-project-");
    const dataRepo = await tempRepo("capshelf-status-fragment-update-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const fragment = join(dataRepo, "settings", "security");

    await mkdir(fragment, { recursive: true });
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security v1");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "settings/security"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    await writeFile(
      join(project, ".claude", "settings.json"),
      `${JSON.stringify({ permissions: { allow: ["Bash(git status *)"] } })}\n`,
    );
    await writeFile(
      join(fragment, "settings.json"),
      `${JSON.stringify({ permissions: { deny: ["Bash(curl *)"] } })}\n`,
    );
    await commitAll(dataRepo, "security v2");

    const status = Bun.spawnSync({
      cmd: [process.execPath, cli, "status", "settings/security", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].state).toBe("drifted_and_update");
    expect(statusJson.items[0].upstreamSha).not.toBe(
      statusJson.items[0].lockedSha,
    );
  });

  test("status --diff ignores untracked generated files in copy items", async () => {
    const project = await tempRepo("capshelf-status-untracked-project-");
    const dataRepo = await tempRepo("capshelf-status-untracked-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const skill = join(dataRepo, "skills", "keyword-research");

    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "keyword research\n");
    await writeFile(join(skill, "scripts", ".gitignore"), ".venv/\n");
    await commitAll(dataRepo, "keyword research skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/keyword-research"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "keyword-research");
    await mkdir(
      join(installed, "scripts", ".venv", "lib", "python3.14", "site-packages"),
      { recursive: true },
    );
    await writeFile(
      join(
        installed,
        "scripts",
        ".venv",
        "lib",
        "python3.14",
        "site-packages",
        "_virtualenv.py",
      ),
      "generated venv\n",
    );

    const status = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "status",
        "skills/keyword-research",
        "--diff",
        "--json",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).not.toContain("_virtualenv.py");
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].state).toBe("ok");
    expect(statusJson.diffs).toEqual([]);
  });

  test("status --diff ignores local-only virtualenv files in non-git projects", async () => {
    const project = await tempDir("capshelf-status-non-git-local-venv-");
    const dataRepo = await tempRepo("capshelf-status-local-venv-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const skill = join(dataRepo, "skills", "keyword-research");

    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "keyword research\n");
    await writeFile(join(skill, "scripts", ".gitignore"), ".venv/\n");
    await writeFile(join(skill, "scripts", "run.sh"), "#!/bin/sh\n");
    await commitAll(dataRepo, "keyword research without venv");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/keyword-research"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    await mkdir(
      join(
        project,
        ".agents",
        "skills",
        "keyword-research",
        "scripts",
        ".venv",
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        project,
        ".agents",
        "skills",
        "keyword-research",
        "scripts",
        ".venv",
        "pyvenv.cfg",
      ),
      "local generated venv\n",
    );

    const status = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "status",
        "keyword-research",
        "--diff",
        "--json",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).not.toContain("pyvenv.cfg");
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].state).toBe("ok");
    expect(statusJson.diffs).toEqual([]);
  });

  test("status --diff respects installed skill gitignore with .venv in non-git projects", async () => {
    const project = await tempDir("capshelf-status-installed-gitignore-");
    const dataRepo = await tempRepo("capshelf-status-data-gitignore-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const skill = join(dataRepo, "skills", "keyword-research");

    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "keyword research\n");
    await writeFile(join(skill, "scripts", ".gitignore"), ".venv\n");
    await writeFile(join(skill, "scripts", "run.sh"), "#!/bin/sh\n");
    await commitAll(dataRepo, "keyword research skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "keyword-research"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const installed = join(project, ".agents", "skills", "keyword-research");
    expect(await file(join(installed, "scripts", ".gitignore")).text()).toBe(
      ".venv\n",
    );

    await mkdir(
      join(installed, "scripts", ".venv", "lib", "python3.14", "site-packages"),
      { recursive: true },
    );
    await writeFile(
      join(
        installed,
        "scripts",
        ".venv",
        "lib",
        "python3.14",
        "site-packages",
        "_virtualenv.py",
      ),
      "generated venv\n",
    );

    const status = Bun.spawnSync({
      cmd: [process.execPath, cli, "status", "keyword-research", "--diff"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).not.toContain(".venv");
    expect(status.stdout.toString()).not.toContain("_virtualenv.py");
    expect(status.stdout.toString()).toContain("data/skills/keyword-research");
    expect(status.stdout.toString()).toContain("(no local drift diff)");
  });

  test("migration commands are absent and legacy dataRepo fails manually", async () => {
    const project = await tempRepo("capshelf-migrate-data-project-");
    const dataRepo = await tempRepo("capshelf-migrate-data-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({
        installMode: "codex-compatible",
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      }),
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "migrate-data-repo-config"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("unknown command");

    const apply = Bun.spawnSync({
      cmd: [process.execPath, cli, "apply"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(apply.exitCode).toBe(1);
    expect(apply.stderr.toString()).toContain("uses the legacy dataRepo field");
    expect(apply.stderr.toString()).toContain("fix it manually");
  });

  // Federation reservations (local/specs/multi-shelf-federation-spec.md,
  // Group 2): colon refs and the manifest "shelves" key both fail through
  // the existing generic-error mapping with exit 1.
  test("reserved colon refs and shelves keys exit 1 through the CLI", async () => {
    const project = await tempRepo("capshelf-reserved-project-");
    const dataRepo = await tempRepo("capshelf-reserved-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "baseline");

    const run = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, cli, ...args],
        cwd: project,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);

    const colonRef = run(["show", "team:security-review"]);
    expect(colonRef.exitCode).toBe(1);
    expect(colonRef.stderr.toString()).toContain(
      '":" is reserved for future shelf-qualified refs',
    );

    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.shelves = [];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    const status = run(["status"]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr.toString()).toContain(
      "multi-shelf federation, which this capshelf version does not support; upgrade capshelf",
    );
  });
});
