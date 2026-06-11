import { describe, expect, test } from "bun:test";
import { $, file } from "bun";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

  test("self-update --check reports through the CLI with Homebrew metadata", async () => {
    const home = await tempDir("capshelf-self-update-home-");
    const bin = await tempDir("capshelf-self-update-bin-");
    const prefix = await tempDir("capshelf-self-update-prefix-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink(cli, join(prefix, "bin", "capshelf"));
    const brew = join(bin, "brew");
    await writeFile(
      brew,
      [
        "#!/bin/sh",
        `formula='genged/tap/capshelf'`,
        `if [ "$1 $2 $3" = "list --formula $formula" ]; then exit 0; fi`,
        `if [ "$1 $2" = "--prefix $formula" ]; then printf '%s\\n' "$FAKE_CAPSHELF_PREFIX"; exit 0; fi`,
        `if [ "$1 $2 $3 $4" = "outdated --json=v2 --formula $formula" ]; then`,
        `  printf '%s\\n' '{"formulae":[{"name":"capshelf","full_name":"genged/tap/capshelf","current_version":"0.3.1"}]}'`,
        "  exit 0",
        "fi",
        "printf 'unexpected brew command: %s\\n' \"$*\" >&2",
        "exit 2",
        "",
      ].join("\n"),
    );
    await chmod(brew, 0o755);

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "self-update", "--check"],
      cwd: home,
      env: {
        ...process.env,
        FAKE_CAPSHELF_PREFIX: prefix,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("latest: 0.3.1");
    expect(result.stdout.toString()).toContain("installer: homebrew");
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

  test("init --data <remote-url> bootstraps a managed clone", async () => {
    const project = await tempRepo("capshelf-bootstrap-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-data-");
    const xdg = await tempDir("capshelf-bootstrap-xdg-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "baseline");
    const url = `file://${dataRepo}`;

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", url],
      cwd: project,
      env: { ...process.env, XDG_DATA_HOME: xdg },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const clonePath = join(
      xdg,
      "capshelf",
      "data",
      "localhost",
      ...dataRepo.split("/").filter(Boolean),
    );
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`cloned data repo:\n  ${url}\n  -> ${clonePath}`);
    expect(stdout).toContain(
      "bound project data repo:\n  .capshelf/local.json",
    );
    // A machine-local file:// path is not a portable upstream, so it is
    // neither printed nor written to the committed manifest.
    expect(stdout).not.toContain("upstream:\n");
    expect(
      await file(join(clonePath, "skills", "hello", "SKILL.md")).text(),
    ).toBe("hello\n");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      { dataRepo: clonePath, skills: [], settings: [], mcp: [] },
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toBeUndefined();

    const add = Bun.spawnSync({
      cmd: [process.execPath, cli, "add", "skills/hello"],
      cwd: project,
      env: { ...process.env, XDG_DATA_HOME: xdg },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(add.exitCode).toBe(0);
    expect(
      await file(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
      ).text(),
    ).toBe("hello\n");
  });

  test("init --data <remote-url> --data-dir clones to the explicit path", async () => {
    const project = await tempRepo("capshelf-bootstrap-dir-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-dir-data-");
    const base = await tempDir("capshelf-bootstrap-dir-dst-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await writeFile(join(dataRepo, "README.md"), "data\n");
    await commitAll(dataRepo, "baseline");
    const clonePath = join(base, "agent-shared");
    // An existing empty directory is a valid clone destination.
    await mkdir(clonePath, { recursive: true });

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "init",
        "--data",
        `file://${dataRepo}`,
        "--data-dir",
        clonePath,
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(await file(join(clonePath, "README.md")).text()).toBe("data\n");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      { dataRepo: clonePath, skills: [], settings: [], mcp: [] },
    );
  });

  test("init rejects --data-dir without a remote data repo URL", async () => {
    const project = await tempRepo("capshelf-bootstrap-dir-local-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-dir-local-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "init",
        "--data",
        dataRepo,
        "--data-dir",
        join(project, "clone"),
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "--data-dir requires --data <remote-data-repo-url>",
    );
  });

  test("init --data <remote-url> with mismatched --upstream fails before writing", async () => {
    const project = await tempRepo("capshelf-bootstrap-upstream-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-upstream-data-");
    const xdg = await tempDir("capshelf-bootstrap-upstream-xdg-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await writeFile(join(dataRepo, "README.md"), "data\n");
    await commitAll(dataRepo, "baseline");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "init",
        "--data",
        `file://${dataRepo}`,
        "--upstream",
        "https://github.com/other/agent-shared",
      ],
      cwd: project,
      env: { ...process.env, XDG_DATA_HOME: xdg },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(4);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "--upstream conflicts with the remote data repo URL passed to --data.",
    );
    expect(stderr).toContain(`--data normalizes to:     file://${dataRepo}`);
    expect(stderr).toContain(
      "--upstream normalizes to: https://github.com/other/agent-shared",
    );
    // Nothing was cloned or written.
    expect(
      await file(join(project, ".capshelf", "capshelf.json")).exists(),
    ).toBe(false);
    expect(await file(join(project, ".capshelf", "local.json")).exists()).toBe(
      false,
    );
    const clonesRoot = join(xdg, "capshelf");
    expect(await file(join(clonesRoot, "data")).exists()).toBe(false);
  });

  test("init --data file:// rejects a file:// --upstream as unsupported", async () => {
    const project = await tempRepo("capshelf-bootstrap-upstream-ok-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-upstream-ok-data-");
    const base = await tempDir("capshelf-bootstrap-upstream-ok-dst-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await writeFile(join(dataRepo, "README.md"), "data\n");
    await commitAll(dataRepo, "baseline");
    const url = `file://${dataRepo}`;

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "init",
        "--data",
        url,
        "--upstream",
        url,
        "--data-dir",
        join(base, "clone"),
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // file:// is rejected as a committed upstream even when it matches the
    // bootstrap URL, since --upstream writes the manifest.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      `unsupported git remote URL: ${url}`,
    );
  });

  test("init skips file:// origins when auto-detecting the upstream", async () => {
    const project = await tempRepo("capshelf-file-origin-project-");
    const dataRepo = await tempRepo("capshelf-file-origin-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await $`git -C ${dataRepo} remote add origin file:///tmp/some/mirror`.quiet();

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
    expect(manifest.dataRepoUpstream).toBeUndefined();
  });

  test("set-upstream rejects file:// URLs", async () => {
    const project = await tempRepo("capshelf-set-upstream-file-project-");
    const dataRepo = await tempRepo("capshelf-set-upstream-file-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "set-upstream", "file:///tmp/some/mirror"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "unsupported git remote URL: file:///tmp/some/mirror",
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toBeUndefined();
  });

  test("init rejects owner/repo shorthand with exit code 3", async () => {
    const project = await tempRepo("capshelf-bootstrap-shorthand-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", "genged/agent-shared"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "data must be a local path or supported git remote URL: genged/agent-shared",
    );
  });

  test("init --data <remote-url> fails on manifest upstream conflict", async () => {
    const project = await tempRepo("capshelf-bootstrap-conflict-project-");
    const dataRepo = await tempRepo("capshelf-bootstrap-conflict-data-");
    const xdg = await tempDir("capshelf-bootstrap-conflict-xdg-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await writeFile(join(dataRepo, "README.md"), "data\n");
    await commitAll(dataRepo, "baseline");
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

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", `file://${dataRepo}`],
      cwd: project,
      env: { ...process.env, XDG_DATA_HOME: xdg },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toContain("wrong upstream");
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

  test("data-path prints the resolved local data repo path", async () => {
    const project = await tempRepo("capshelf-data-path-project-");
    const dataRepo = await tempRepo("capshelf-data-path-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const plain = Bun.spawnSync({
      cmd: [process.execPath, cli, "data-path"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.toString().trim()).toBe(dataRepo);

    const json = Bun.spawnSync({
      cmd: [process.execPath, cli, "data-path", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.toString())).toEqual({
      path: dataRepo,
      upstream: null,
    });

    const setUpstream = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "set-upstream",
        "git@github.com:mg/agent-shared.git",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(setUpstream.exitCode).toBe(0);
    await $`git -C ${dataRepo} remote add origin git@github.com:mg/agent-shared.git`.quiet();

    const withUpstream = Bun.spawnSync({
      cmd: [process.execPath, cli, "data-path", "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(withUpstream.exitCode).toBe(0);
    expect(JSON.parse(withUpstream.stdout.toString())).toEqual({
      path: dataRepo,
      upstream: "https://github.com/mg/agent-shared",
    });
  });

  test("set-data and set-upstream support --json", async () => {
    const project = await tempRepo("capshelf-set-json-project-");
    const dataRepo = await tempRepo("capshelf-set-json-data-");
    const otherRepo = await tempRepo("capshelf-set-json-other-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const setData = Bun.spawnSync({
      cmd: [process.execPath, cli, "set-data", otherRepo, "--json"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(setData.exitCode).toBe(0);
    expect(JSON.parse(setData.stdout.toString())).toEqual({
      project,
      dataRepo: otherRepo,
    });
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      { dataRepo: otherRepo, skills: [], settings: [], mcp: [] },
    );

    const setUpstream = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "set-upstream",
        "git@github.com:mg/agent-shared.git",
        "--json",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(setUpstream.exitCode).toBe(0);
    expect(JSON.parse(setUpstream.stdout.toString())).toEqual({
      project,
      dataRepoUpstream: "https://github.com/mg/agent-shared",
    });
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toBe(
      "https://github.com/mg/agent-shared",
    );
  });

  test("set-data rejects remote data repo URLs with exit code 3", async () => {
    const project = await tempRepo("capshelf-set-data-url-project-");
    const dataRepo = await tempRepo("capshelf-set-data-url-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    const url = "https://github.com/genged/agent-shared";
    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "set-data", url],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "set-data expects a local data repo path, not a remote data repo URL.",
    );
    expect(stderr).toContain(`capshelf init --data ${url}`);
    expect(stderr).toContain(`git clone ${url} <path>`);
    expect(stderr).toContain("capshelf set-data <path>");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      { dataRepo, skills: [], settings: [], mcp: [] },
    );
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

  test("promote prints where the commit landed and a push hint with origin", async () => {
    const project = await tempRepo("capshelf-promote-output-project-");
    const dataRepo = await tempRepo("capshelf-promote-output-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await commitAll(dataRepo, "baseline");

    for (const args of [
      ["init", "--data", dataRepo],
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

  test("ls renders metadata, filters by --tag, and keeps bare rows unchanged", async () => {
    const project = await tempRepo("capshelf-ls-meta-project-");
    const dataRepo = await tempRepo("capshelf-ls-meta-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: frontmatter fallback\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "description: Deep multi-pass security audit of changed files, with extended notes",
        "tags: [Security, review]",
        "",
      ].join("\n"),
    );
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", ".capshelf.yml"),
      "description: Baseline permission allowlist.\ntags: [security]\n",
    );
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

    const ls = run(["ls"]);
    expect(ls.exitCode).toBe(0);
    const out = ls.stdout.toString();
    // 60-char truncation plus ellipsis; tags render as #tag suffixes.
    expect(out).toContain(
      "Deep multi-pass security audit of changed files, with extend…  #Security #review",
    );
    expect(out).toContain("Baseline permission allowlist.  #security");
    // A metadata-less row stays exactly kind/name + sha.
    expect(out).toMatch(/^ {2}skills\/hello {2,}[0-9a-f]{12}$/m);

    // --tag is AND and case-insensitive, and combines with --kind.
    const tagged = run(["ls", "--tag", "SECURITY"]);
    expect(tagged.exitCode).toBe(0);
    expect(tagged.stdout.toString()).toContain("skills/security-review");
    expect(tagged.stdout.toString()).toContain("settings/permissions-base");
    expect(tagged.stdout.toString()).not.toContain("skills/hello");

    const narrowed = run(["ls", "--tag", "security", "--tag", "review"]);
    expect(narrowed.stdout.toString()).toContain("skills/security-review");
    expect(narrowed.stdout.toString()).not.toContain(
      "settings/permissions-base",
    );

    const kinded = run(["ls", "--tag", "security", "--kind", "settings"]);
    expect(kinded.stdout.toString()).not.toContain("skills/security-review");
    expect(kinded.stdout.toString()).toContain("settings/permissions-base");

    const json = run(["ls", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    const review = parsed.data.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(review.description).toBe(
      "Deep multi-pass security audit of changed files, with extended notes",
    );
    expect(review.tags).toEqual(["Security", "review"]);
    const hello = parsed.data.find(
      (row: { name: string }) => row.name === "hello",
    );
    expect(hello.description).toBeUndefined();
    expect(hello.tags).toBeUndefined();
    // The bundled system skill carries its frontmatter description.
    expect(parsed.system[0].description).toContain("capshelf CLI");
  });

  test("ls --here enriches installed rows best-effort and filters by --tag", async () => {
    const project = await tempRepo("capshelf-ls-here-meta-project-");
    const dataRepo = await tempRepo("capshelf-ls-here-meta-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      "tags: [security]\n",
    );
    await commitAll(dataRepo, "baseline");

    const env = { ...process.env, CAPSHELF_HOME: "" };
    const run = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, cli, ...args],
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

    expect(run(["init", "--data", dataRepo]).exitCode).toBe(0);
    expect(run(["add", "skills/security-review"]).exitCode).toBe(0);

    const here = run(["ls", "--here", "--json"]);
    expect(here.exitCode).toBe(0);
    const rows = JSON.parse(here.stdout.toString());
    const review = rows.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(review.description).toBe("Audit changed files.");
    expect(review.tags).toEqual(["security"]);

    const human = run(["ls", "--here"]);
    expect(human.stdout.toString()).toContain(
      "Audit changed files.  #security",
    );

    const tagged = run(["ls", "--here", "--tag", "security", "--json"]);
    expect(
      JSON.parse(tagged.stdout.toString()).map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["security-review"]);

    // With no data repo bound, ls --here still works; fields are omitted.
    await rm(join(project, ".capshelf", "local.json"));
    const unbound = run(["ls", "--here", "--json"]);
    expect(unbound.exitCode).toBe(0);
    const unboundRows = JSON.parse(unbound.stdout.toString());
    const unboundReview = unboundRows.find(
      (row: { name: string }) => row.name === "security-review",
    );
    expect(unboundReview.description).toBeUndefined();
    expect(unboundReview.tags).toBeUndefined();
  });

  test("show prints a metadata block with relation install state", async () => {
    const project = await tempRepo("capshelf-show-meta-project-");
    const dataRepo = await tempRepo("capshelf-show-meta-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nbody\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "tags: [security, review]",
        "requires: [settings/permissions-base]",
        "conflicts-with: [skills/quick-review]",
        "",
      ].join("\n"),
    );
    await writeFile(join(dataRepo, "skills", "hello", "SKILL.md"), "hello\n");
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
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
    expect(run(["add", "settings/permissions-base"]).exitCode).toBe(0);

    const human = run(["show", "skills/security-review", "--no-content"]);
    expect(human.exitCode).toBe(0);
    const out = human.stdout.toString();
    expect(out).toContain("description: Audit changed files.");
    expect(out).toContain("tags:        security, review");
    expect(out).toContain("settings/permissions-base (installed)");
    expect(out).toContain("skills/quick-review (not installed)");

    const json = run(["show", "skills/security-review", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout.toString());
    expect(parsed.metadata).toEqual({
      description: "Audit changed files.",
      tags: ["security", "review"],
      requires: [{ ref: "settings/permissions-base", installed: true }],
      conflictsWith: [{ ref: "skills/quick-review", installed: false }],
    });

    // metadata is always present, even for items without any metadata.
    const bare = JSON.parse(
      run(["show", "skills/hello", "--json"]).stdout.toString(),
    );
    expect(bare.metadata).toEqual({
      tags: [],
      requires: [],
      conflictsWith: [],
    });

    // System items report frontmatter metadata the same way.
    const system = JSON.parse(
      run(["show", "capshelf", "--json"]).stdout.toString(),
    );
    expect(system.metadata.description).toContain("capshelf CLI");
    expect(system.metadata.requires).toEqual([]);
  });

  test("search ranks matches across fields and includes system items", async () => {
    const project = await tempRepo("capshelf-search-project-");
    const dataRepo = await tempRepo("capshelf-search-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "security-review"), {
      recursive: true,
    });
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "skills", "security-review", "SKILL.md"),
      "---\nname: security-review\ndescription: Audit changed files.\n---\nCheck for SQL injection.\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      "tags: [security, review]\n",
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      '{ "permissions": { "deny": ["Bash(curl *)"] } }\n',
    );
    await writeFile(
      join(dataRepo, "settings", "permissions-base", ".capshelf.yml"),
      "description: Baseline security allowlist.\n",
    );
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

    // Name hit (8) outranks the description hit (2).
    const search = run(["search", "security"]);
    expect(search.exitCode).toBe(0);
    const out = search.stdout.toString();
    expect(out).toMatch(/^\d+ matches in .+ \(\+ system\)$/m);
    const reviewIndex = out.indexOf("skills/security-review");
    const baseIndex = out.indexOf("settings/permissions-base");
    expect(reviewIndex).toBeGreaterThan(-1);
    expect(baseIndex).toBeGreaterThan(reviewIndex);
    expect(out).toContain("matched: name");
    expect(out).toContain("Audit changed files.  #security #review");

    // Content matching annotates the first matching file.
    const content = run(["search", "injection"]);
    expect(content.stdout.toString()).toContain("matched: content(SKILL.md)");

    // Multi-word queries are AND; quoted and unquoted forms both work.
    const multi = run(["search", "sql", "injection", "--json"]);
    expect(multi.exitCode).toBe(0);
    const parsed = JSON.parse(multi.stdout.toString());
    expect(parsed.query).toBe("sql injection");
    expect(parsed.dataRepo).toBe(dataRepo);
    const dataResults = parsed.results.filter(
      (row: { source: string }) => row.source === "data",
    );
    expect(dataResults).toHaveLength(1);
    expect(dataResults[0].name).toBe("security-review");
    expect(dataResults[0].score).toBe(2);
    expect(dataResults[0].tags).toEqual(["security", "review"]);
    expect(dataResults[0].matches).toEqual([
      { term: "sql", field: "content", file: "SKILL.md" },
      { term: "injection", field: "content", file: "SKILL.md" },
    ]);

    // --kind narrows the searched population.
    const kinded = run(["search", "security", "--kind", "settings", "--json"]);
    expect(
      JSON.parse(kinded.stdout.toString()).results.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["permissions-base"]);

    // Bundled system items are searched too.
    const system = run(["search", "capshelf", "--json"]);
    const systemRows = JSON.parse(system.stdout.toString()).results;
    expect(
      systemRows.some(
        (row: { source: string; name: string }) =>
          row.source === "system" && row.name === "capshelf",
      ),
    ).toBe(true);

    // Zero matches: friendly output, empty results, exit 0.
    const none = run(["search", "definitely-not-on-the-shelf"]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout.toString()).toContain("(no matches)");
    const noneJson = run(["search", "definitely-not-on-the-shelf", "--json"]);
    expect(noneJson.exitCode).toBe(0);
    expect(JSON.parse(noneJson.stdout.toString()).results).toEqual([]);
  });

  test("add warns about missing requires and refuses declared conflicts", async () => {
    const project = await tempRepo("capshelf-add-relations-project-");
    const dataRepo = await tempRepo("capshelf-add-relations-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    for (const skill of ["security-review", "quick-review", "loner"]) {
      await mkdir(join(dataRepo, "skills", skill), { recursive: true });
      await writeFile(
        join(dataRepo, "skills", skill, "SKILL.md"),
        `${skill}\n`,
      );
    }
    await mkdir(join(dataRepo, "settings", "permissions-base"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "settings", "permissions-base", "settings.json"),
      "{}\n",
    );
    await writeFile(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
      [
        "requires:",
        "  - settings/permissions-base",
        "  - mcp/github",
        "conflicts-with:",
        "  - skills/quick-review",
        "  - skills/deleted-upstream",
        "",
      ].join("\n"),
    );
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

    // Missing requires warn with exact fix commands, install succeeds, and
    // --json appends missingRequires. A conflict ref pointing at an item
    // that exists nowhere (skills/deleted-upstream) is ignored.
    const add = run(["add", "skills/security-review", "--json"]);
    expect(add.exitCode).toBe(0);
    const stderr = add.stderr.toString();
    expect(stderr).toContain(
      "missing required items for skills/security-review:",
    );
    expect(stderr).toContain(
      "settings/permissions-base — install with: capshelf add settings/permissions-base",
    );
    expect(stderr).toContain(
      "mcp/github — install with: capshelf add mcp/github",
    );
    expect(JSON.parse(add.stdout.toString()).missingRequires).toEqual([
      "settings/permissions-base",
      "mcp/github",
    ]);

    // Installing a declared requirement shrinks the warning on re-add.
    expect(run(["add", "settings/permissions-base"]).exitCode).toBe(0);
    const readd = run(["add", "skills/security-review", "--json"]);
    expect(readd.exitCode).toBe(0);
    expect(readd.stderr.toString()).not.toContain("settings/permissions-base");
    expect(JSON.parse(readd.stdout.toString()).missingRequires).toEqual([
      "mcp/github",
    ]);

    // Forward conflict: the new item declares it.
    const conflict = run(["add", "skills/quick-review"]);
    expect(conflict.exitCode).toBe(3);
    const conflictErr = conflict.stderr.toString();
    expect(conflictErr).toContain(
      "not installing skills/quick-review — conflicts with installed skills/security-review",
    );
    expect(conflictErr).toContain(
      "declared by: skills/security-review/.capshelf.yml",
    );
    expect(conflictErr).toContain(
      "remove the conflicting item first: capshelf rm skills/security-review",
    );
    expect(conflictErr).toContain(
      join(dataRepo, "skills", "security-review", ".capshelf.yml"),
    );

    // An unrelated item still installs.
    expect(run(["add", "skills/loner"]).exitCode).toBe(0);
  });

  test("add refuses the reverse conflict direction and tolerates malformed sidecars", async () => {
    const project = await tempRepo("capshelf-add-reverse-project-");
    const dataRepo = await tempRepo("capshelf-add-reverse-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    for (const skill of ["quick-review", "security-review", "broken-meta"]) {
      await mkdir(join(dataRepo, "skills", skill), { recursive: true });
      await writeFile(
        join(dataRepo, "skills", skill, "SKILL.md"),
        `${skill}\n`,
      );
    }
    // Only quick-review declares the conflict; the check is symmetric.
    await writeFile(
      join(dataRepo, "skills", "quick-review", ".capshelf.yml"),
      "conflicts-with: [skills/security-review]\n",
    );
    await writeFile(
      join(dataRepo, "skills", "broken-meta", ".capshelf.yml"),
      "tags: [unclosed\n",
    );
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
    expect(run(["add", "skills/quick-review"]).exitCode).toBe(0);

    const reverse = run(["add", "skills/security-review"]);
    expect(reverse.exitCode).toBe(3);
    const err = reverse.stderr.toString();
    expect(err).toContain(
      "not installing skills/security-review — conflicts with installed skills/quick-review",
    );
    expect(err).toContain("declared by: skills/quick-review/.capshelf.yml");

    // A malformed sidecar warns but never blocks the install.
    const malformed = run(["add", "skills/broken-meta"]);
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stderr.toString()).toContain(
      "skills/broken-meta: invalid .capshelf.yml",
    );
  });

  test("search content scanning skips binary and oversize files in real repos", async () => {
    const project = await tempRepo("capshelf-search-skip-project-");
    const dataRepo = await tempRepo("capshelf-search-skip-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const skill = join(dataRepo, "skills", "mixed");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "contains textneedle marker\n");
    // A NUL byte marks the file as binary; its needle must not match.
    await writeFile(
      join(skill, "blob.bin"),
      Buffer.concat([
        Buffer.from("nulneedle "),
        Buffer.from([0x00, 0x01, 0x02]),
      ]),
    );
    // Over the 256 KiB content cap; its needle must not match either.
    await writeFile(
      join(skill, "big.txt"),
      `${"x".repeat(256 * 1024)} hugeneedle\n`,
    );
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

    // The fixture is searchable through its text file…
    const text = run(["search", "textneedle", "--json"]);
    expect(text.exitCode).toBe(0);
    expect(
      JSON.parse(text.stdout.toString()).results.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(["mixed"]);

    // …but binary and oversize files are skipped, still exiting 0.
    for (const needle of ["nulneedle", "hugeneedle"]) {
      const skipped = run(["search", needle, "--json"]);
      expect(skipped.exitCode).toBe(0);
      expect(JSON.parse(skipped.stdout.toString()).results).toEqual([]);
    }
  });

  test("update after a metadata-only data repo commit is a full no-op", async () => {
    const project = await tempRepo("capshelf-meta-noop-project-");
    const dataRepo = await tempRepo("capshelf-meta-noop-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(dataRepo, "skills", "hello"), { recursive: true });
    await writeFile(
      join(dataRepo, "skills", "hello", "SKILL.md"),
      "---\nname: hello\n---\nhello v1\n",
    );
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
    expect(run(["add", "skills/hello"]).exitCode).toBe(0);
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lockBefore = await readFile(lockPath, "utf-8");

    // A metadata-only commit upstream: sha unchanged AND sourceCommit
    // computed sidecar-blind, so the lock must stay byte-identical.
    await writeFile(
      join(dataRepo, "skills", "hello", ".capshelf.yml"),
      "description: says hello\ntags: [greeting]\n",
    );
    await commitAll(dataRepo, "tag hello");

    const status = run(["status", "skills/hello", "--strict", "--json"]);
    expect(status.exitCode).toBe(0);

    const update = run(["update", "skills/hello", "--json"]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout.toString()).toContain('"action": "already-current"');
    expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
  });

  test("status degrades a non-git data repo path to missing_upstream", async () => {
    const project = await tempRepo("capshelf-status-nongit-project-");
    const dataRepo = await tempRepo("capshelf-status-nongit-data-");
    const notARepo = await tempDir("capshelf-status-nongit-dir-");
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
    expect(run(["add", "hello"]).exitCode).toBe(0);

    const localPath = join(project, ".capshelf", "local.json");
    const local = await file(localPath).json();
    await writeFile(
      localPath,
      JSON.stringify({ ...local, dataRepo: notARepo }, null, 2),
    );

    const status = run(["status", "--json"]);
    expect(status.exitCode).toBe(0);
    const rows = JSON.parse(status.stdout.toString()).items;
    const hello = rows.find(
      (row: { name: string; kind: string }) =>
        row.kind === "skills" && row.name === "hello",
    );
    expect(hello.state).toBe("missing_upstream");

    expect(run(["status", "--strict"]).exitCode).toBe(4);
  });
});
