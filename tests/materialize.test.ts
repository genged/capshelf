import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dataKey } from "../src/lock";
import { lastTouchingCommit } from "../src/git";
import { shaOfItem } from "../src/master";
import { materializeLockEntry } from "../src/materialize";
import { CLI_INTEGRATION_TEST_TIMEOUT_MS } from "./cli-fixtures";
import { inventoryLocalTree } from "../src/gitignore";

async function tempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function tempRepo(): Promise<string> {
  const repo = await tempDir("capshelf-materialize-repo-");
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email capshelf@example.invalid`.quiet();
  await $`git -C ${repo} config user.name capshelf`.quiet();
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

function isExecutable(path: string): boolean {
  return (lstatSync(path).mode & 0o111) !== 0;
}

describe("materializeLockEntry", () => {
  test("restores data item content from sourceCommit and removes stale files", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await writeFile(join(dataItem, ".gitignore"), "generated/\n");
    await writeFile(
      join(dataItem, ".env.1password"),
      "API_KEY=op://vault/key\n",
    );
    await writeFile(join(dataItem, ".secret"), "secret\n");
    await mkdir(join(dataItem, "scripts"), { recursive: true });
    await writeFile(join(dataItem, "scripts", "run.sh"), "#!/bin/sh\n");
    await chmod(join(dataItem, "scripts", "run.sh"), 0o755);
    await mkdir(join(dataItem, "nested", ".gitignore"), { recursive: true });
    await writeFile(
      join(dataItem, "nested", ".gitignore", "ignored.txt"),
      "ignored\n",
    );
    await commitAll(dataRepo, "hello v1");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const sha = await shaOfItem(dataItem);

    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "stale.txt"), "stale\n");

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
      },
      scope: "project",
    });

    expect(result.action).toBe("reconciled");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("hello v1\n");
    expect(await file(join(installed, ".gitignore")).text()).toBe(
      "generated/\n",
    );
    expect(await file(join(installed, ".env.1password")).text()).toBe(
      "API_KEY=op://vault/key\n",
    );
    expect(isExecutable(join(installed, "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(installed, ".secret"))).toBe(true);
    expect(
      existsSync(join(installed, "nested", ".gitignore", "ignored.txt")),
    ).toBe(true);
    expect(existsSync(join(installed, "stale.txt"))).toBe(false);
    expect(
      lstatSync(join(project, ".claude", "skills", "hello")).isSymbolicLink(),
    ).toBe(true);
  });

  test("apply never writes a committed root sidecar and hashes consistently", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(join(dataItem, "sub"), { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await writeFile(join(dataItem, ".capshelf.yml"), "tags: [a]\n");
    await writeFile(join(dataItem, "sub", ".capshelf.yml"), "content\n");
    await commitAll(dataRepo, "hello with sidecar");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    // The working-tree sha already excludes the root sidecar.
    const sha = await shaOfItem(dataItem);
    const entry = {
      source: "data" as const,
      sha,
      sourceCommit,
      appliedAt: new Date().toISOString(),
    };

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry,
      scope: "project",
    });

    expect(result.action).toBe("reconciled");
    expect(existsSync(join(installed, ".capshelf.yml"))).toBe(false);
    expect(existsSync(join(installed, "sub", ".capshelf.yml"))).toBe(true);

    // The at-commit sha equals the working-tree sha: a dry-run verification
    // against the same entry passes and reports already-current.
    const dryRun = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry,
      scope: "project",
      dryRun: true,
    });
    expect(dryRun.action).toBe("already-current");
  });

  test("dry-run reports reconciliation without touching installed files", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-project-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const sha = await shaOfItem(dataItem);

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local drift\n");
    await writeFile(join(installed, "stale.txt"), "stale\n");

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
      },
      scope: "project",
      dryRun: true,
    });

    expect(result.action).toBe("would-reconcile");
    expect(result.dryRun).toBe(true);
    expect(result.plannedSha).toBe(sha);
    expect(await file(join(installed, "SKILL.md")).text()).toBe(
      "local drift\n",
    );
    expect(existsSync(join(installed, "stale.txt"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "hello"))).toBe(false);
  });

  test("preserves ignored local-only files while replacing managed content", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-preserve-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, ".gitignore"), "cache/\n");
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const v1 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };
    await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v1,
      scope: "project",
    });
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(join(installed, "cache", "state.db"), "local state\n");

    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");
    const v2 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v2,
      previousEntry: v1,
      scope: "project",
    });

    expect(result.action).toBe("reconciled");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("hello v2\n");
    expect(await file(join(installed, "cache", "state.db")).text()).toBe(
      "local state\n",
    );
  });

  test("carries ignored symlinks and real file modes across a replacement", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-row4-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, ".gitignore"), "node_modules/\nsecrets/\n");
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const v1 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };
    await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v1,
      scope: "project",
    });

    // Row 4 of the object-model table: local state under a managed directory
    // never crosses a Git boundary, so Git's two-mode model does not apply
    // and a symlink is preserved by target rather than refused.
    await mkdir(join(installed, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(installed, "node_modules", "lib"), { recursive: true });
    await writeFile(join(installed, "node_modules", "lib", "x.js"), "mod\n");
    await symlink("../lib/x.js", join(installed, "node_modules", ".bin", "x"));
    await mkdir(join(installed, "secrets"), { recursive: true });
    const secret = join(installed, "secrets", "tokens.json");
    await writeFile(secret, '{"t":1}');
    await chmod(secret, 0o600);
    const readOnly = join(installed, "secrets", "pinned.pem");
    await writeFile(readOnly, "key\n");
    await chmod(readOnly, 0o400);

    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await commitAll(dataRepo, "hello v2");
    const v2 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };
    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v2,
      previousEntry: v1,
      scope: "project",
    });

    expect(result.action).toBe("reconciled");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("hello v2\n");
    const link = join(installed, "node_modules", ".bin", "x");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toBe("../lib/x.js");
    expect(lstatSync(secret).mode & 0o7777).toBe(0o600);
    // 0400 must not gain write either: the mode is carried, not normalized.
    expect(lstatSync(readOnly).mode & 0o7777).toBe(0o400);
    // Managed content still normalizes to Git's two modes.
    expect(lstatSync(join(installed, "SKILL.md")).mode & 0o7777).toBe(0o644);

    // A second pass sees no drift: preserved entries are compared, not
    // rewritten, so the item converges instead of reconciling forever.
    const again = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v2,
      scope: "project",
    });
    expect(again.action).toBe("already-current");
  });

  test("refuses a non-recreatable object on write but only on write", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-fifo-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, ".gitignore"), "run/\n");
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const entry = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };
    await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry,
      scope: "project",
    });

    await mkdir(join(installed, "run"), { recursive: true });
    await $`mkfifo ${join(installed, "run", "pipe")}`.quiet();

    // A fifo cannot be recreated by a directory replacement, so the write
    // path names the path and refuses. `rm` still inventories and deletes it.
    await expect(
      materializeLockEntry({
        project,
        dataRepo,
        key: dataKey("skills", "hello"),
        entry,
        scope: "project",
      }),
    ).rejects.toThrow(/unsupported filesystem object: run\/pipe/);
    expect(await inventoryLocalTree(installed)).toMatchObject({
      irregular: [{ path: "run/pipe", type: "other" }],
    });
  });

  test("refuses collisions between ignored local files and selected managed content", async () => {
    const dataRepo = await tempRepo();
    const project = await tempDir("capshelf-materialize-collision-");
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, ".gitignore"), "cache/\n");
    await writeFile(join(dataItem, "SKILL.md"), "hello v1\n");
    await commitAll(dataRepo, "hello v1");
    const v1 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };
    await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry: v1,
      scope: "project",
    });
    await mkdir(join(installed, "cache"), { recursive: true });
    await writeFile(join(installed, "cache", "state.db"), "local state\n");

    await writeFile(join(dataItem, "SKILL.md"), "hello v2\n");
    await mkdir(join(dataItem, "cache"), { recursive: true });
    await writeFile(join(dataItem, "cache", "state.db"), "managed state\n");
    await $`git -C ${dataRepo} add -f skills/hello/cache/state.db`.quiet();
    await commitAll(dataRepo, "hello v2");
    const v2 = {
      source: "data" as const,
      sha: await shaOfItem(dataItem),
      sourceCommit: await lastTouchingCommit(dataRepo, "skills/hello"),
      appliedAt: new Date().toISOString(),
    };

    await expect(
      materializeLockEntry({
        project,
        dataRepo,
        key: dataKey("skills", "hello"),
        entry: v2,
        previousEntry: v1,
        scope: "project",
        dryRun: true,
      }),
    ).rejects.toThrow(/ignored local path cache\/state\.db collides/);
    expect(await file(join(installed, "SKILL.md")).text()).toBe("hello v1\n");
    expect(await file(join(installed, "cache", "state.db")).text()).toBe(
      "local state\n",
    );
  });

  test("local scope verifies git-excluded installs against the filesystem", async () => {
    const dataRepo = await tempRepo();
    // The project is itself a Git repo whose info/exclude hides the install
    // path, exactly how add --local leaves it. Git-visible hashing would see
    // an empty file list here and fail verification with the empty digest.
    const project = await tempRepo();
    const dataItem = join(dataRepo, "skills", "hello");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(dataItem, { recursive: true });
    await writeFile(join(dataItem, "SKILL.md"), "hello local\n");
    await commitAll(dataRepo, "hello local");
    const sourceCommit = await lastTouchingCommit(dataRepo, "skills/hello");
    const sha = await shaOfItem(dataItem);
    await writeFile(
      join(project, ".git", "info", "exclude"),
      ".agents/skills/hello/\n.claude/skills/hello\n",
    );
    const entry = {
      source: "data" as const,
      sha,
      sourceCommit,
      appliedAt: new Date().toISOString(),
    };

    const result = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry,
      scope: "local",
    });

    expect(result.action).toBe("reconciled");
    expect(result.sha).toBe(sha);
    expect(await file(join(installed, "SKILL.md")).text()).toBe(
      "hello local\n",
    );

    const dryRun = await materializeLockEntry({
      project,
      dataRepo,
      key: dataKey("skills", "hello"),
      entry,
      scope: "local",
      dryRun: true,
    });
    expect(dryRun.action).toBe("already-current");
    expect(dryRun.currentSha).toBe(sha);
  });

  test("does not touch keep-local data items", async () => {
    const project = await tempDir("capshelf-materialize-project-");
    const installed = join(project, ".agents", "skills", "hello");

    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "SKILL.md"), "local\n");

    const result = await materializeLockEntry({
      project,
      dataRepo: "/unused",
      key: dataKey("skills", "hello"),
      entry: {
        source: "data",
        sha: "locked",
        sourceCommit: "commit",
        appliedAt: new Date().toISOString(),
        local: true,
        localReason: "project-specific",
      },
      scope: "project",
    });

    expect(result.action).toBe("kept-local");
    expect(result.message).toBe("project-specific");
    expect(await file(join(installed, "SKILL.md")).text()).toBe("local\n");
  });
});

describe("materialization source reads", () => {
  test(
    "apply reads the item source tree once, not once per preflight pass",
    async () => {
      const realGit = Bun.which("git");
      if (!realGit) throw new Error("git is required for this test");
      const dataRepo = await tempRepo();
      const dataItem = join(dataRepo, "skills", "big");
      await mkdir(dataItem, { recursive: true });
      await writeFile(
        join(dataItem, "SKILL.md"),
        "---\nname: big\ndescription: big\n---\nv1\n",
      );
      const fileCount = 12;
      for (let index = 1; index < fileCount; index += 1) {
        await writeFile(join(dataItem, `f${index}.md`), `file ${index}\n`);
      }
      await commitAll(dataRepo, "big skill");

      const project = await tempDir("capshelf-git-calls-project-");
      await $`git -C ${project} init -q`.quiet();
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const run = (args: string[]) =>
        Bun.spawnSync({
          cmd: [process.execPath, cli, ...args],
          cwd: project,
          env: process.env,
          stdout: "pipe",
          stderr: "pipe",
        });
      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      expect(run(["add", "skills/big"]).exitCode).toBe(0);
      await writeFile(
        join(project, ".agents", "skills", "big", "SKILL.md"),
        "drifted\n",
      );

      // A shim on PATH logs every git invocation before exec'ing the real
      // binary, so this counts subprocesses rather than trusting a code read.
      const shimDir = await tempDir("capshelf-git-shim-");
      const log = join(shimDir, "calls.log");
      await writeFile(
        join(shimDir, "git"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      );
      await chmod(join(shimDir, "git"), 0o755);

      const previousPath = process.env.PATH;
      process.env.PATH = `${shimDir}:${previousPath ?? ""}`;
      try {
        expect(run(["apply", "skills/big", "--yes"]).exitCode).toBe(0);
      } finally {
        process.env.PATH = previousPath;
      }

      const calls = (await file(log).text()).split("\n").filter(Boolean);
      // One `git ls-tree` and one `git show` per file for the whole command.
      // Plan, revalidate, and materialize used to re-read the tree each time,
      // and each pass ran two planners: 14 full reads per copy item.
      expect(calls.filter((line) => line.includes("ls-tree")).length).toBe(1);
      expect(calls.filter((line) => line.includes(" show ")).length).toBe(
        fileCount,
      );
      expect(calls.length).toBeLessThan(fileCount * 4);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
