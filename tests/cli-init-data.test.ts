import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

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
    expect(manifest.dataRepoUpstream).toContain("https://example.invalid/");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo,
        skills: [],
        piExtensions: [],
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

  test("init refuses to create accidental non-portable project state", async () => {
    const project = await tempRepo("capshelf-init-no-origin-project-");
    const dataRepo = await tempRepo("capshelf-init-no-origin-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "could not determine a portable data repo upstream",
    );
    expect(result.stderr.toString()).toContain(
      "fresh clones know where shared items come from",
    );
    expect(result.stderr.toString()).toContain("--no-upstream");
    expect(
      await file(join(project, ".capshelf", "capshelf.json")).exists(),
    ).toBe(false);
  });

  test("project commands resolve from any subdirectory, and fail only outside a project", async () => {
    const project = await tempRepo("capshelf-root-discovery-project-");
    const dataRepo = await tempRepo("capshelf-root-discovery-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const init = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(init.exitCode).toBe(0);

    // A nested subdirectory resolves up to the project root (git-style).
    await mkdir(join(project, "nested", "deep"), { recursive: true });
    const fromNested = Bun.spawnSync({
      cmd: [process.execPath, cli, "status"],
      cwd: join(project, "nested", "deep"),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromNested.exitCode).toBe(0);

    // Outside any project it still fails with a clear message.
    const outside = await tempDir("capshelf-root-discovery-outside-");
    const fromOutside = Bun.spawnSync({
      cmd: [process.execPath, cli, "status"],
      cwd: outside,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(fromOutside.exitCode).toBe(3);
    expect(fromOutside.stderr.toString()).toContain("not a capshelf project");
  });

  test("read-only browse commands run with --data outside any project", async () => {
    const dataRepo = await tempRepo("capshelf-browse-data-");
    const outside = await tempDir("capshelf-browse-outside-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    // ls/search/show are read-only inspection of the shelf, so a user can
    // evaluate a data repo before adopting it into any project.
    for (const args of [["ls"], ["search", "skill"]]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, cli, "--data", dataRepo, ...args],
        cwd: outside,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ args, code: result.exitCode }).toEqual({ args, code: 0 });
      expect(result.stderr.toString()).not.toContain("not a capshelf project");
    }
  });

  test("data-repo commands are grouped under `data`, old names hidden aliases", async () => {
    const dataRepo = await tempRepo("capshelf-datagrp-data-");
    const project = await tempRepo("capshelf-datagrp-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const run = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, cli, "--data", dataRepo, ...args],
        cwd: project,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

    expect(run(["init", "--no-upstream"]).exitCode).toBe(0);

    // Grouped form and the legacy top-level alias behave identically.
    const grouped = run(["data", "path"]);
    const legacy = run(["data-path"]);
    expect(grouped.exitCode).toBe(0);
    expect(legacy.exitCode).toBe(0);
    expect(grouped.stdout.toString()).toBe(legacy.stdout.toString());

    // Help shows the `data` group but hides the legacy top-level names.
    const help = run(["--help"]).stdout.toString();
    expect(help).toContain("data ");
    expect(help).not.toContain("data-path");
    expect(help).not.toContain("set-data");
  });

  test("--json emits a JSON error envelope with the typed exit code", async () => {
    const outside = await tempDir("capshelf-json-error-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "status", "--json"],
      cwd: outside,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // "not a capshelf project" is a precondition (exit 3), and --json means an
    // agent gets a parseable envelope on stderr, not prose.
    expect(result.exitCode).toBe(3);
    const envelope = JSON.parse(result.stderr.toString());
    expect(envelope.error.exitCode).toBe(3);
    expect(envelope.error.message).toContain("not a capshelf project");
    // Human channel is untouched — no bare ✗ prose leaked into the JSON.
    expect(result.stderr.toString()).not.toContain("✗");
    // No ANSI escapes either. Bun colorizes console.error when stderr is a
    // TTY, which would wrap the envelope in escape codes and break
    // JSON.parse for any agent running capshelf through a pty.
    expect(result.stderr.toString()).not.toContain(String.fromCharCode(27));
  });

  test("keep-local refuses an item with no divergence", async () => {
    const project = await tempRepo("capshelf-keeplocal-project-");
    const dataRepo = await tempRepo("capshelf-keeplocal-data-");
    const skill = join(dataRepo, "skills", "greet");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "name: greet\n---\nhi\n");
    await $`git -C ${dataRepo} add -A`.quiet();
    await $`git -C ${dataRepo} commit -qm seed`.quiet();
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const run = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, cli, "--data", dataRepo, ...args],
        cwd: project,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

    expect(run(["init", "--no-upstream"]).exitCode).toBe(0);
    expect(run(["add", "skills/greet"]).exitCode).toBe(0);

    // Freshly added: installed content matches the lock, so there is no drift
    // to accept — keep-local must refuse rather than silently marking it local.
    const kept = run(["keep-local", "skills/greet"]);
    expect(kept.exitCode).toBe(3);
    expect(kept.stderr.toString()).toContain("no local divergence");
  });

  test("self-update source execution stays source-or-unknown", async () => {
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
    expect(result.stdout.toString()).toContain("update available: no");
    expect(result.stdout.toString()).toContain("installer: source-or-unknown");
  });

  test("init honors --no-upstream for repos with origin", async () => {
    const project = await tempRepo("capshelf-init-no-upstream-project-");
    const dataRepo = await tempRepo("capshelf-init-no-upstream-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await $`git -C ${dataRepo} remote set-url origin git@github.com:mg/agent-shared.git`.quiet();

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

    expect(result.exitCode).toBe(3);
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
      cmd: [process.execPath, cli, "init", "--data", url, "--no-upstream"],
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
      {
        dataRepo: clonePath,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
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
        "--no-upstream",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(await file(join(clonePath, "README.md")).text()).toBe("data\n");
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo: clonePath,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
  });

  test("init bootstraps a cloned project from committed upstream", async () => {
    const project = await tempRepo("capshelf-cloned-init-project-");
    const xdg = await tempDir("capshelf-cloned-init-xdg-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const upstream = "https://github.com/acme/agent-config";
    const clonePath = join(
      xdg,
      "capshelf",
      "data",
      "github.com",
      "acme",
      "agent-config",
    );
    await mkdir(clonePath, { recursive: true });
    await $`git -C ${clonePath} init -q`.quiet();
    await $`git -C ${clonePath} config user.email capshelf@example.invalid`.quiet();
    await $`git -C ${clonePath} config user.name capshelf`.quiet();
    await writeFile(join(clonePath, "README.md"), "data\n");
    await commitAll(clonePath, "baseline");
    await $`git -C ${clonePath} remote add origin ${upstream}`.quiet();
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({
        installMode: "codex-compatible",
        dataRepoUpstream: upstream,
        skills: [],
        settings: [],
        mcp: [],
      }),
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init"],
      cwd: project,
      env: { ...process.env, CAPSHELF_HOME: "", XDG_DATA_HOME: xdg },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`using existing data repo clone:\n  ${upstream}`);
    expect(stdout).toContain(`  -> ${clonePath}`);
    expect(stdout).toContain(
      "bound project data repo:\n  .capshelf/local.json",
    );
    expect(await file(join(project, ".capshelf", "local.json")).json()).toEqual(
      {
        dataRepo: clonePath,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toBe(upstream);
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
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      `unsupported git remote URL: ${url}`,
    );
  });

  test("init requires --no-upstream for file:// origins", async () => {
    const project = await tempRepo("capshelf-file-origin-project-");
    const dataRepo = await tempRepo("capshelf-file-origin-data-", {
      origin: "file:///tmp/some/mirror",
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "could not determine a portable data repo upstream",
    );
    expect(
      await file(join(project, ".capshelf", "capshelf.json")).exists(),
    ).toBe(false);

    const explicit = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(explicit.exitCode).toBe(0);
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

    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "unsupported git remote URL: file:///tmp/some/mirror",
    );
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.dataRepoUpstream).toContain("https://example.invalid/");
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
    await $`git -C ${dataRepo} remote set-url origin https://github.com/user/fork.git`.quiet();

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
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(JSON.parse(json.stdout.toString())).toEqual({
      path: dataRepo,
      upstream: manifest.dataRepoUpstream,
    });

    await $`git -C ${dataRepo} remote set-url origin git@github.com:mg/agent-shared.git`.quiet();
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
      cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
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
      {
        dataRepo: otherRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
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
      {
        dataRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
  });

  test("apply explains cloned project binding when no data repo is configured", async () => {
    const project = await tempRepo("capshelf-apply-unbound-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const upstream = "https://github.com/acme/agent-config";
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({
        installMode: "codex-compatible",
        dataRepoUpstream: upstream,
        skills: ["hello"],
        settings: [],
        mcp: [],
      }),
    );
    await writeFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      JSON.stringify({
        version: 2,
        items: {
          "data/skills/hello": {
            source: "data",
            sha: "abc123",
            sourceCommit: "deadbeef",
            appliedAt: "2026-06-11T00:00:00.000Z",
          },
        },
      }),
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "apply"],
      cwd: project,
      env: { ...process.env, CAPSHELF_HOME: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(6);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "upstream (per .capshelf/capshelf.json): https://github.com/acme/agent-config",
    );
    expect(stderr).toContain(`git clone ${upstream} <path>`);
    expect(stderr).toContain("capshelf set-data <path>");
    expect(stderr).toContain("capshelf apply");
  });

  test("apply reports missing dataRepoUpstream when a cloned project cannot be discovered", async () => {
    const project = await tempRepo("capshelf-apply-undiscoverable-project-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await mkdir(join(project, ".capshelf"), { recursive: true });
    await writeFile(
      join(project, ".capshelf", "capshelf.json"),
      JSON.stringify({
        installMode: "codex-compatible",
        skills: ["hello"],
        settings: [],
        mcp: [],
      }),
    );
    await writeFile(
      join(project, ".capshelf", "capshelf.lock.json"),
      JSON.stringify({
        version: 2,
        items: {
          "data/skills/hello": {
            source: "data",
            sha: "abc123",
            sourceCommit: "deadbeef",
            appliedAt: "2026-06-11T00:00:00.000Z",
          },
        },
      }),
    );

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "apply"],
      cwd: project,
      env: { ...process.env, CAPSHELF_HOME: "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(6);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      ".capshelf/capshelf.json does not declare dataRepoUpstream",
    );
    expect(stderr).toContain("capshelf set-upstream <data-repo-url>");
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
    const initManifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    await $`git -C ${wrongRepo} remote set-url origin ${initManifest.dataRepoUpstream}`.quiet();

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
      {
        dataRepo: originalRepo,
        skills: [],
        piExtensions: [],
        settings: [],
        mcp: [],
      },
    );
  });
});
