import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `${name}\n`);
}

function initGitRepo(path: string): void {
  const result = Bun.spawnSync({
    cmd: ["git", "init", "-q"],
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

async function writeProjectManifest(project: string): Promise<void> {
  await mkdir(join(project, ".capshelf"), { recursive: true });
  await writeFile(
    join(project, ".capshelf", "capshelf.json"),
    `${JSON.stringify({ skills: [] }, null, 2)}\n`,
  );
}

async function writeProjectDataBinding(
  project: string,
  dataRepo: string,
): Promise<void> {
  await writeFile(
    join(project, ".capshelf", "local.json"),
    `${JSON.stringify(
      {
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      },
      null,
      2,
    )}\n`,
  );
}

function userEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
  };
}

function runCli(
  cli: string,
  cwd: string,
  home: string,
  args: string[],
): Bun.SyncSubprocess<"pipe", "pipe"> {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, ...args],
    cwd,
    env: userEnv(home),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("user-level inventory CLI", () => {
  test("status --user inventories user skills without a capshelf project", async () => {
    const home = await tempDir("capshelf-user-home-");
    const cwd = await tempDir("capshelf-user-cwd-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await writeSkill(join(home, ".claude", "skills"), "alpha");
    await writeSkill(join(home, ".agents", "skills"), "beta");
    await writeSkill(join(home, ".codex", "skills"), "gamma");
    await writeSkill(join(home, ".codex", "skills"), ".system");

    const result = runCli(cli, cwd, home, ["status", "--user", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const json = JSON.parse(result.stdout.toString());
    expect(json.project).toBeNull();
    expect(json.count).toBe(3);
    expect(
      json.externalUserSkills.map(
        (skill: { name: string; surface: string }) =>
          `${skill.surface}:${skill.name}`,
      ),
    ).toEqual(["claude:alpha", "codex:beta", "codex:gamma"]);
    expect(
      json.externalUserSkills.find(
        (skill: { name: string }) => skill.name === "gamma",
      )?.path,
    ).toBe(join(home, ".codex", "skills", "gamma"));
  });

  test("status --user human output splits Claude and Codex skills", async () => {
    const home = await tempDir("capshelf-user-human-home-");
    const cwd = await tempDir("capshelf-user-human-cwd-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await writeSkill(join(home, ".claude", "skills"), "alpha");
    await writeSkill(join(home, ".agents", "skills"), "beta");

    const result = runCli(cli, cwd, home, ["status", "--user"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const stdout = result.stdout.toString();
    const claudeHeader = stdout.indexOf("external/user/claude/");
    const codexHeader = stdout.indexOf("external/user/codex/");
    expect(claudeHeader).toBeGreaterThanOrEqual(0);
    expect(codexHeader).toBeGreaterThan(claudeHeader);
    expect(stdout).toContain("skills/alpha");
    expect(stdout).toContain("skills/beta");
  });

  test("ls --user reports shadowing when run from a capshelf project root", async () => {
    const home = await tempDir("capshelf-user-shadow-home-");
    const project = await tempDir("capshelf-user-shadow-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await writeSkill(join(home, ".claude", "skills"), "alpha");
    await writeProjectManifest(project);
    await writeFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      `${JSON.stringify(
        {
          version: 2,
          items: {
            "data/skills/alpha": {
              source: "data",
              sha: "abc",
              sourceCommit: "commit",
              appliedAt: "now",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = runCli(cli, project, home, ["ls", "--user", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const rows = await new Response(result.stdout).json();
    expect(rows).toEqual([
      {
        kind: "skills",
        name: "alpha",
        surface: "claude",
        path: join(home, ".claude", "skills", "alpha"),
        shadows: [{ scope: "project", source: "data" }],
      },
    ]);
    expect(await file(join(project, ".capshelf", "local.json")).exists()).toBe(
      false,
    );
  });

  test("status includes user-level skills by default", async () => {
    const home = await tempDir("capshelf-user-status-default-home-");
    const project = await tempDir("capshelf-user-status-default-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await writeSkill(join(home, ".claude", "skills"), "alpha");
    await writeSkill(join(home, ".agents", "skills"), "beta");
    await writeProjectManifest(project);
    await writeFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      `${JSON.stringify(
        {
          version: 2,
          items: {
            "data/skills/alpha": {
              source: "data",
              sha: "abc",
              sourceCommit: "commit",
              appliedAt: "now",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = runCli(cli, project, home, ["status", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const json = JSON.parse(result.stdout.toString());
    expect(json.externalUserSkills).toEqual([
      {
        kind: "skills",
        name: "alpha",
        surface: "claude",
        path: join(home, ".claude", "skills", "alpha"),
        shadows: [{ scope: "project", source: "data" }],
      },
      {
        kind: "skills",
        name: "beta",
        surface: "codex",
        path: join(home, ".agents", "skills", "beta"),
        shadows: [],
      },
    ]);

    const projectOnly = runCli(cli, project, home, [
      "status",
      "--project",
      "--json",
    ]);
    expect(projectOnly.exitCode).toBe(0);
    expect(
      JSON.parse(projectOnly.stdout.toString()).externalUserSkills,
    ).toEqual([]);
  });

  test("ls includes user-level skills by default", async () => {
    const home = await tempDir("capshelf-user-ls-default-home-");
    const project = await tempDir("capshelf-user-ls-default-project-");
    const dataRepo = await tempDir("capshelf-user-ls-default-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    initGitRepo(dataRepo);
    await writeSkill(join(home, ".agents", "skills"), "beta");
    await writeProjectManifest(project);
    await writeProjectDataBinding(project, dataRepo);

    const result = runCli(cli, project, home, ["ls", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString()).externalUserSkills).toEqual([
      {
        kind: "skills",
        name: "beta",
        surface: "codex",
        path: join(home, ".agents", "skills", "beta"),
        shadows: [],
      },
    ]);

    const settingsOnly = runCli(cli, project, home, [
      "ls",
      "--kind",
      "settings",
      "--json",
    ]);
    expect(settingsOnly.exitCode).toBe(0);
    expect(
      JSON.parse(settingsOnly.stdout.toString()).externalUserSkills,
    ).toEqual([]);
  });

  test("rejects user inventory flags that imply managed project state", async () => {
    const home = await tempDir("capshelf-user-flags-home-");
    const cwd = await tempDir("capshelf-user-flags-cwd-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const cases = [
      {
        args: ["status", "--user", "--project"],
        message: "--user cannot be combined with --project or --local",
      },
      {
        args: ["status", "--user", "--diff"],
        message: "--diff is not supported with --user",
      },
      {
        args: ["ls", "--user", "--here"],
        message: "--here and --user cannot be used together",
      },
      {
        args: ["ls", "--user", "--tag", "workflow"],
        message: "--tag is not supported with --user",
      },
    ];

    for (const entry of cases) {
      const result = runCli(cli, cwd, home, entry.args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(entry.message);
    }
  });
});
