import { describe, expect, test } from "bun:test";
import { $, file } from "bun";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("cli integration", () => {
  test("reports missing git with exit code 7", async () => {
    const project = await tempDir("capshelf-cli-project-");
    const dataRepo = await tempDir("capshelf-cli-data-");
    const home = await tempDir("capshelf-cli-home-");
    const emptyPath = await tempDir("capshelf-empty-path-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(project, { recursive: true });

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        PATH: emptyPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr.toString()).toContain(
      "git is required but was not found on PATH",
    );
  });

  test("init writes portable manifest, local config, and gitignore", async () => {
    const project = await tempRepo("capshelf-init-project-");
    const dataRepo = await tempRepo("capshelf-init-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepo).toBeUndefined();
    expect(manifest.dataRepoUpstream).toBeUndefined();
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      },
    );
    expect(
      await readFile(join(project, ".capshelf", ".gitignore"), "utf-8"),
    ).toContain("local.json");
    expect(
      await file(join(project, ".capshelf", "capshelf.lock.json")).exists(),
    ).toBe(true);
  });

  test("project commands require running from the capshelf project root", async () => {
    const project = await tempRepo("capshelf-root-only-project-");
    const dataRepo = await tempRepo("capshelf-root-only-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, "nested"), { recursive: true });
    const fromNested = Bun.spawnSync({
      cmd: [process.execPath, cli, "status"],
      cwd: join(project, "nested"),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromNested.exitCode).toBe(1);
    expect(fromNested.stderr.toString()).toContain(
      "not a capshelf project root",
    );

    const fromMetadata = Bun.spawnSync({
      cmd: [process.execPath, cli, "status"],
      cwd: join(project, ".capshelf"),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromMetadata.exitCode).toBe(1);
    expect(fromMetadata.stderr.toString()).toContain(
      "not a capshelf project root",
    );
  });

  test("init honors --no-upstream for repos with origin", async () => {
    const project = await tempRepo("capshelf-init-no-upstream-project-");
    const dataRepo = await tempRepo("capshelf-init-no-upstream-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await $`git -C ${dataRepo} remote add origin git@github.com:mg/agent-shared.git`.quiet();

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toBeUndefined();
  });

  test("init rejects --upstream with --no-upstream", async () => {
    const project = await tempRepo("capshelf-init-upstream-conflict-project-");
    const dataRepo = await tempRepo("capshelf-init-upstream-conflict-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "init",
        "--data",
        dataRepo,
        "--upstream",
        "https://github.com/mg/agent-shared",
        "--no-upstream",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "--upstream and --no-upstream cannot be used together",
    );
  });

  test("set-data rejects upstream mismatches with exit code 4", async () => {
    const project = await tempRepo("capshelf-set-data-project-");
    const dataRepo = await tempRepo("capshelf-set-data-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({
        installMode: "codex-compatible",
        dataRepoUpstream: "https://github.com/org/canonical",
        skills: [],
        settings: [],
        mcp: [],
      }),
    );
    await $`git -C ${dataRepo} remote add origin https://github.com/user/fork.git`.quiet();

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "set-data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toContain("wrong upstream");
  });

  test("set-data verifies existing lock entries before replacing local config", async () => {
    const project = await tempRepo("capshelf-set-data-lock-project-");
    const originalRepo = await tempRepo("capshelf-set-data-lock-original-");
    const wrongRepo = await tempRepo("capshelf-set-data-lock-wrong-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(originalRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(originalRepo, "skills", "hello", "SKILL.md"),
      "hello\n",
    );
    await commitAll(originalRepo, "hello");

    await mkdir(join(wrongRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(wrongRepo, "skills", "hello", "SKILL.md"), "wrong\n");
    await commitAll(wrongRepo, "wrong hello");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", originalRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/hello"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "set-data", wrongRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("does not contain commit");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      { dataRepo: originalRepo, skills: [], settings: [], mcp: [] },
    );
  });

  test("add --local writes local manifest, lock, excludes, and status group", async () => {
    const project = await tempRepo("capshelf-local-project-");
    const dataRepo = await tempRepo("capshelf-local-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/local-only"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["local-only"],
        settings: [],
        mcp: [],
      },
    );
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/local-only"].source).toBe("data");
    const projectManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(projectManifest.skills).toEqual([]);
    const metadataIgnore = await readFile(
      join(project, ".capshelf", ".gitignore"),
      "utf-8",
    );
    expect(metadataIgnore).toContain("local.json");
    expect(metadataIgnore).toContain("local.lock.json");
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".capshelf/local.json");
    expect(exclude).not.toContain(".capshelf/local.lock.json");
    expect(exclude).toContain(".agents/skills/local-only/");

    const status = Bun.spawnSync({
      cmd: [process.execPath, cli, "status", "--local", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].scope).toBe("local");
    expect(statusJson.items[0].kind).toBe("skills");
    expect(statusJson.items[0].name).toBe("local-only");
    expect(statusJson.items[0].state).toBe("ok");

    const lsHere = Bun.spawnSync({
      cmd: [process.execPath, cli, "ls", "--here", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(lsHere.exitCode).toBe(0);
    const installedItems = JSON.parse(lsHere.stdout.toString()) as Array<{
      scope?: string;
      kind?: string;
      name?: string;
    }>;
    expect(
      installedItems.some(
        (item) =>
          item.scope === "local" &&
          item.kind === "skills" &&
          item.name === "local-only",
      ),
    ).toBe(true);

    const move = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "move",
        "skills/local-only",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(move.exitCode).toBe(0);

    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      },
    );
    const nextLocalLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(nextLocalLock.items["data/skills/local-only"]).toBeUndefined();
    const nextProjectManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(nextProjectManifest.skills).toEqual(["local-only"]);
    const nextExclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(nextExclude).not.toContain(".agents/skills/local-only/");
    expect(nextExclude).not.toContain(".claude/skills/local-only");

    const gitStatus =
      await $`git -C ${project} status --short -- .agents/skills/local-only .claude/skills/local-only`.text();
    expect(gitStatus).toContain(".agents/skills/local-only");
  });

  test("rm --local removes local skill files and git exclude entries", async () => {
    const project = await tempRepo("capshelf-rm-local-project-");
    const dataRepo = await tempRepo("capshelf-rm-local-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "local-remove"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "local-remove", "SKILL.md"),
      "remove me\n",
    );
    await commitAll(dataRepo, "local removable skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/local-remove"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);
    let exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/local-remove/");
    expect(exclude).toContain(".claude/skills/local-remove");

    const rm = Bun.spawnSync({
      cmd: [process.execPath, cli, "rm", "--local", "skills/local-remove"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(rm.exitCode).toBe(0);

    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/local-remove"]).toBeUndefined();
    expect(
      await file(join(project, ".agents", "skills", "local-remove")).exists(),
    ).toBe(false);
    expect(
      await file(join(project, ".claude", "skills", "local-remove")).exists(),
    ).toBe(false);
    exclude = await readFile(join(project, ".git", "info", "exclude"), "utf-8");
    expect(exclude).not.toContain(".agents/skills/local-remove/");
    expect(exclude).not.toContain(".claude/skills/local-remove");
  });

  test("add --local works in non-git projects without git excludes", async () => {
    const project = await tempDir("capshelf-local-non-git-project-");
    const dataRepo = await tempRepo("capshelf-local-non-git-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "local-only"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["local-only"],
        settings: [],
        mcp: [],
      },
    );
  });

  test("add --local treats a capshelf project nested under parent git as non-git", async () => {
    const parent = await tempRepo("capshelf-local-parent-git-");
    const project = join(parent, "examples", "old-albums");
    const dataRepo = await tempRepo("capshelf-local-nested-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(project), { recursive: true });
    await mkdir(join(dataRepo, "skills", "local-only"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "local-only", "SKILL.md"),
      "local\n",
    );
    await commitAll(dataRepo, "local skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "local-only"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);
    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(
      await file(join(parent, ".git", "info", "exclude")).text(),
    ).not.toContain(".agents/skills/local-only/");
  });

  test("share adopts a new skill into local scope by default", async () => {
    const project = await tempRepo("capshelf-share-local-project-");
    const dataRepo = await tempRepo("capshelf-share-local-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "draft"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "draft", "SKILL.md"),
      "draft\n",
    );

    const share = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "skills/draft"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(0);

    expect(
      await file(join(dataRepo, "skills", "draft", "SKILL.md")).text(),
    ).toBe("draft\n");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["draft"],
        settings: [],
        mcp: [],
      },
    );
    const localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/draft"].source).toBe("data");
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/draft/");
  });

  test("share to local copies ignored skill files from the filesystem", async () => {
    const project = await tempRepo("capshelf-share-ignored-project-");
    const dataRepo = await tempRepo("capshelf-share-ignored-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await writeFile(join(project, ".gitignore"), ".agents/skills/ignored/\n");
    await commitAll(project, "ignore local skill path");
    await mkdir(join(project, ".agents", "skills", "ignored"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "ignored", "SKILL.md"),
      "ignored content\n",
    );

    const share = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "skills/ignored"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(0);
    expect(
      await file(join(dataRepo, "skills", "ignored", "SKILL.md")).text(),
    ).toBe("ignored content\n");

    const status = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "status",
        "--local",
        "skills/ignored",
        "--json",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.exitCode).toBe(0);
    const statusJson = JSON.parse(status.stdout.toString());
    expect(statusJson.items[0].state).toBe("ok");
  });

  test("share normalizes real claude skills in non-git projects without generated files", async () => {
    const project = await tempDir("capshelf-share-claude-non-git-project-");
    const dataRepo = await tempRepo("capshelf-share-claude-non-git-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const skillDir = join(project, ".claude", "skills", "from-claude");
    await mkdir(join(skillDir, "scripts", ".venv"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "from claude\n");
    await writeFile(join(skillDir, "scripts", ".gitignore"), ".venv/\n");
    await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\n");
    await writeFile(join(skillDir, "scripts", ".venv", "pyvenv.cfg"), "venv\n");

    const share = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "skills/from-claude",
        "--to",
        "project",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(0);

    expect(
      await file(join(dataRepo, "skills", "from-claude", "SKILL.md")).text(),
    ).toBe("from claude\n");
    expect(
      await file(
        join(dataRepo, "skills", "from-claude", "scripts", "run.sh"),
      ).text(),
    ).toBe("#!/bin/sh\n");
    expect(
      await file(
        join(dataRepo, "skills", "from-claude", "scripts", ".venv"),
      ).exists(),
    ).toBe(false);
    expect(
      await file(
        join(project, ".agents", "skills", "from-claude", "SKILL.md"),
      ).text(),
    ).toBe("from claude\n");
  });

  test("share adopts a new skill into project scope", async () => {
    const project = await tempRepo("capshelf-share-project-project-");
    const dataRepo = await tempRepo("capshelf-share-project-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "policy"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "policy", "SKILL.md"),
      "policy\n",
    );

    const share = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "skills/policy", "--to", "project"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(0);

    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["policy"]);
    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/skills/policy"].source).toBe("data");
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".agents/skills/policy/");
  });

  test("share to local rejects a project-git-tracked skill path", async () => {
    const project = await tempRepo("capshelf-share-tracked-project-");
    const dataRepo = await tempRepo("capshelf-share-tracked-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    await mkdir(join(project, ".agents", "skills", "tracked"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "tracked", "SKILL.md"),
      "tracked\n",
    );
    await $`git -C ${project} add .agents/skills/tracked/SKILL.md`.quiet();
    await $`git -C ${project} commit -qm "track local skill"`.quiet();

    const share = Bun.spawnSync({
      cmd: [process.execPath, cli, "share", "skills/tracked"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(share.exitCode).toBe(3);
    expect(share.stderr.toString()).toContain(
      "local install path is already tracked by git",
    );
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).not.toContain(".agents/skills/tracked/");
    expect(await file(join(dataRepo, "skills", "tracked")).exists()).toBe(
      false,
    );
  });

  test("move changes tracked skill scope in both directions", async () => {
    const project = await tempRepo("capshelf-move-project-");
    const dataRepo = await tempRepo("capshelf-move-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "toggle"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "toggle", "SKILL.md"), "toggle\n");
    await commitAll(dataRepo, "toggle skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/toggle"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const toProject = Bun.spawnSync({
      cmd: [process.execPath, cli, "move", "skills/toggle", "--to", "project"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(toProject.exitCode).toBe(0);
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        settings: [],
        mcp: [],
      },
    );
    let manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual(["toggle"]);
    let localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/toggle"]).toBeUndefined();

    const toLocal = Bun.spawnSync({
      cmd: [process.execPath, cli, "move", "skills/toggle", "--to", "local"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(toLocal.exitCode).toBe(0);
    manifest = await file(join(project, ".capshelf", "capshelf.json")).json();
    expect(manifest.skills).toEqual([]);
    localLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(localLock.items["data/skills/toggle"].source).toBe("data");
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual(["toggle"]);
    const exclude = await readFile(
      join(project, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".agents/skills/toggle/");
  });

  test("move to local works in non-git projects without git excludes", async () => {
    const project = await tempDir("capshelf-move-non-git-project-");
    const dataRepo = await tempRepo("capshelf-move-non-git-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "toggle"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "toggle", "SKILL.md"), "toggle\n");
    await commitAll(dataRepo, "toggle skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/toggle"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const move = Bun.spawnSync({
      cmd: [process.execPath, cli, "move", "skills/toggle", "--to", "local"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(move.exitCode).toBe(0);
    expect(await file(join(project, ".git", "info", "exclude")).exists()).toBe(
      false,
    );
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: ["toggle"],
        settings: [],
        mcp: [],
      },
    );
  });

  test("move recovers a partial local-to-project scope change", async () => {
    const project = await tempRepo("capshelf-move-partial-project-");
    const dataRepo = await tempRepo("capshelf-move-partial-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "partial"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "partial", "SKILL.md"),
      "partial\n",
    );
    await commitAll(dataRepo, "partial skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);
    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/partial"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const localLock = await file(localLockPath).json();
    const projectLock = await file(projectLockPath).json();
    projectLock.items["data/skills/partial"] =
      localLock.items["data/skills/partial"];
    await writeFile(
      projectLockPath,
      `${JSON.stringify(projectLock, null, 2)}\n`,
    );
    const manifest = await file(manifestPath).json();
    manifest.skills.push("partial");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const recovered = Bun.spawnSync({
      cmd: [process.execPath, cli, "move", "skills/partial", "--to", "project"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(recovered.exitCode).toBe(0);

    const nextLocalLock = await file(localLockPath).json();
    expect(nextLocalLock.items["data/skills/partial"]).toBeUndefined();
    const localConfig = await file(
      join(project, ".capshelf", "local.json"),
    ).json();
    expect(localConfig.skills).toEqual([]);
    const nextManifest = await file(manifestPath).json();
    expect(nextManifest.skills).toEqual(["partial"]);
  });

  test("move recovers a partial project-to-local scope change after excludes", async () => {
    const project = await tempRepo("capshelf-move-to-local-partial-project-");
    const dataRepo = await tempRepo("capshelf-move-to-local-partial-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "partial-local"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "partial-local", "SKILL.md"),
      "partial local\n",
    );
    await commitAll(dataRepo, "partial local skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);
    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/partial-local"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const localConfigPath = join(project, ".capshelf", "local.json");
    const localLockPath = join(project, ".capshelf", "local.lock.json");
    const projectLockPath = join(project, ".capshelf", "capshelf.lock.json");
    const projectLock = await file(projectLockPath).json();
    const localLock = {
      version: 2,
      items: {
        "data/skills/partial-local":
          projectLock.items["data/skills/partial-local"],
      },
    };
    await writeFile(localLockPath, `${JSON.stringify(localLock, null, 2)}\n`);
    const localConfig = await file(localConfigPath).json();
    localConfig.skills.push("partial-local");
    await writeFile(
      localConfigPath,
      `${JSON.stringify(localConfig, null, 2)}\n`,
    );
    await writeFile(
      join(project, ".git", "info", "exclude"),
      ".agents/skills/partial-local/\n.claude/skills/partial-local\n",
    );

    const recovered = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "move",
        "skills/partial-local",
        "--to",
        "local",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(recovered.exitCode).toBe(0);

    const nextProjectLock = await file(projectLockPath).json();
    expect(nextProjectLock.items["data/skills/partial-local"]).toBeUndefined();
    const nextManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(nextManifest.skills).toEqual([]);
    const nextLocalLock = await file(localLockPath).json();
    expect(nextLocalLock.items["data/skills/partial-local"].source).toBe(
      "data",
    );
  });

  test("promote --local syncs a local-scope skill without changing project scope", async () => {
    const project = await tempRepo("capshelf-promote-local-project-");
    const dataRepo = await tempRepo("capshelf-promote-local-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "local-edit", "scripts"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "local-edit", "SKILL.md"),
      "before\n",
    );
    await writeFile(
      join(dataRepo, "skills", "local-edit", "scripts", ".gitignore"),
      ".venv/\n",
    );
    await commitAll(dataRepo, "local edit skill");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);
    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "--local", "skills/local-edit"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);

    const beforeLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    await writeFile(
      join(project, ".agents", "skills", "local-edit", "SKILL.md"),
      "after\n",
    );
    await writeFile(
      join(project, ".agents", "skills", "local-edit", "scripts", "new.py"),
      "print('new')\n",
    );
    await mkdir(
      join(project, ".agents", "skills", "local-edit", "scripts", ".venv"),
      { recursive: true },
    );
    await writeFile(
      join(
        project,
        ".agents",
        "skills",
        "local-edit",
        "scripts",
        ".venv",
        "pyvenv.cfg",
      ),
      "generated\n",
    );
    const promote = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "promote",
        "--local",
        "skills/local-edit",
        "-m",
        "promote local edit",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(promote.exitCode).toBe(0);
    expect(promote.stderr.toString()).not.toContain("deprecated");

    expect(
      await file(join(dataRepo, "skills", "local-edit", "SKILL.md")).text(),
    ).toBe("after\n");
    expect(
      await file(
        join(dataRepo, "skills", "local-edit", "scripts", "new.py"),
      ).text(),
    ).toBe("print('new')\n");
    expect(
      await file(
        join(
          dataRepo,
          "skills",
          "local-edit",
          "scripts",
          ".venv",
          "pyvenv.cfg",
        ),
      ).exists(),
    ).toBe(false);
    const afterLock = await file(
      join(project, ".capshelf", "local.lock.json"),
    ).json();
    expect(afterLock.items["data/skills/local-edit"].sha).not.toBe(
      beforeLock.items["data/skills/local-edit"].sha,
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.skills).toEqual([]);
  });

  test("promote syncs a project-scope skill from a non-git project", async () => {
    const project = await tempDir("capshelf-promote-non-git-project-");
    const dataRepo = await tempRepo("capshelf-promote-non-git-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    await mkdir(join(dataRepo, "skills", "keyword-research", "scripts"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "SKILL.md"),
      "before\n",
    );
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "scripts", ".gitignore"),
      ".venv/\n",
    );
    await writeFile(
      join(dataRepo, "skills", "keyword-research", "scripts", "run.sh"),
      "#!/bin/sh\n",
    );
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
    await writeFile(join(installed, "SKILL.md"), "after\n");
    await writeFile(join(installed, "scripts", "parse.py"), "print('new')\n");
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
      "generated\n",
    );

    const promote = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "promote",
        "keyword-research",
        "-m",
        "promote keyword research",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(promote.exitCode).toBe(0);
    expect(
      await file(
        join(dataRepo, "skills", "keyword-research", "SKILL.md"),
      ).text(),
    ).toBe("after\n");
    expect(
      await file(
        join(dataRepo, "skills", "keyword-research", "scripts", "parse.py"),
      ).text(),
    ).toBe("print('new')\n");
    expect(
      await file(
        join(
          dataRepo,
          "skills",
          "keyword-research",
          "scripts",
          ".venv",
          "lib",
          "python3.14",
          "site-packages",
          "_virtualenv.py",
        ),
      ).exists(),
    ).toBe(false);
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
    expect(rejected.stderr.toString()).toContain("requires --from");

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
});
