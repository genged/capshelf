import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { commitAll, runInProcess, tempDir, tempRepo } from "./cli-fixtures";

async function initProject(project: string, dataRepo: string): Promise<void> {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const result = Bun.spawnSync({
    cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
    cwd: project,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
}

describe("human-readable DX output", () => {
  test("init suggests discovery and bundle next steps", async () => {
    const project = await tempRepo("capshelf-dx-init-project-");
    const dataRepo = await tempRepo("capshelf-dx-init-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");

    const result = Bun.spawnSync({
      cmd: [process.execPath, cli, "init", "--data", dataRepo, "--no-upstream"],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("next:");
    expect(stdout).toContain("capshelf search <task>");
    expect(stdout).toContain("capshelf ls");
    expect(stdout).toContain("capshelf add bundles/<name>");
  });

  test("share prints the local data repo location without push guidance when there is no origin", async () => {
    const project = await tempRepo("capshelf-dx-share-project-");
    const dataRepo = await tempRepo("capshelf-dx-share-data-", {
      origin: null,
    });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await initProject(project, dataRepo);
    await mkdir(join(project, ".agents", "skills", "hello"), {
      recursive: true,
    });
    await writeFile(
      join(project, ".agents", "skills", "hello", "SKILL.md"),
      "hello\n",
    );

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "skills/hello",
        "--to",
        "project",
        "-m",
        "share hello",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(`committed to local data repo:\n  ${dataRepo}`);
    expect(stdout).not.toContain("to share upstream:");
  });

  test("share prints push guidance when the data repo has an origin", async () => {
    const project = await tempRepo("capshelf-dx-share-origin-project-");
    const dataRepo = await tempRepo("capshelf-dx-share-origin-data-");
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    await initProject(project, dataRepo);
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ env: { TEAM_MODE: "platform" } }, null, 2),
    );

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        cli,
        "share",
        "settings/team-env",
        "--pick",
        "env",
        "--to",
        "project",
        "-m",
        "share team env",
      ],
      cwd: project,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      `to share upstream:\n  cd ${dataRepo}\n  git push`,
    );
  });
});

/**
 * Target coverage: every command that describes an `mcp` or `subagents` item
 * says which runtime targets it covers, which it does not, and where the
 * missing source belongs.
 */
describe("runtime target coverage", () => {
  async function writeMcpItem(
    dataRepo: string,
    name: string,
    targets: { claude?: boolean; codex?: boolean },
  ): Promise<void> {
    await mkdir(join(dataRepo, "mcp", name), { recursive: true });
    if (targets.claude) {
      await writeFile(
        join(dataRepo, "mcp", name, "claude.json"),
        JSON.stringify({ mcpServers: { [name]: { command: `${name}-mcp` } } }),
      );
    }
    if (targets.codex) {
      await writeFile(
        join(dataRepo, "mcp", name, "codex.toml"),
        `[mcp_servers.${name}]\ncommand = "${name}-mcp"\n`,
      );
    }
  }

  async function writeSubagentItem(
    dataRepo: string,
    name: string,
    targets: { claude?: boolean; codex?: boolean },
  ): Promise<void> {
    await mkdir(join(dataRepo, "subagents", name), { recursive: true });
    if (targets.claude) {
      await writeFile(
        join(dataRepo, "subagents", name, "claude.md"),
        `---\nname: ${name}\ndescription: reviews changes\n---\nbody\n`,
      );
    }
    if (targets.codex) {
      await writeFile(
        join(dataRepo, "subagents", name, "codex.toml"),
        `name = "${name}"\ndescription = "reviews changes"\ndeveloper_instructions = "body"\n`,
      );
    }
  }

  interface Fixture {
    project: string;
    dataRepo: string;
    run: ReturnType<typeof runInProcess>;
  }

  async function fixture(prefix: string): Promise<Fixture> {
    const project = await tempRepo(`capshelf-${prefix}-project-`);
    const dataRepo = await tempRepo(`capshelf-${prefix}-data-`, {
      origin: null,
    });
    await writeMcpItem(dataRepo, "deepwiki", { claude: true });
    await writeMcpItem(dataRepo, "github", { claude: true, codex: true });
    await writeMcpItem(dataRepo, "codexwiki", { codex: true });
    await writeSubagentItem(dataRepo, "reviewer", { claude: true });
    await mkdir(join(dataRepo, "settings", "base"), { recursive: true });
    await writeFile(
      join(dataRepo, "settings", "base", "settings.json"),
      JSON.stringify({ env: { BASE: "1" } }),
    );
    await mkdir(join(dataRepo, "codex", "config", "defaults"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "codex", "config", "defaults", "config.toml"),
      'model = "gpt-5"\n',
    );
    await commitAll(dataRepo, "baseline");
    const run = runInProcess(project);
    expect(
      (await run(["init", "--data", dataRepo, "--no-upstream"])).exitCode,
    ).toBe(0);
    return { project, dataRepo, run };
  }

  /** A `codex` stub on PATH plus an untrusted CODEX_HOME, so the trust
   * warning is emitted whenever the gate lets it through. */
  async function codexEnv(): Promise<Record<string, string>> {
    const binDir = await tempDir("capshelf-codex-bin-");
    const stub = join(binDir, "codex");
    await writeFile(stub, "#!/bin/sh\nexit 0\n");
    await chmod(stub, 0o755);
    return {
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      CODEX_HOME: await tempDir("capshelf-codex-home-"),
    };
  }

  test("add of a claude-only mcp item names the target it does not cover", async () => {
    const { project, run } = await fixture("coverage-add-claude-only");

    const add = await run(["add", "mcp/deepwiki"]);
    expect(add.exitCode).toBe(0);
    const stdout = add.stdout.toString();
    expect(stdout).toContain("  targets:");
    expect(stdout).toContain(`Claude  written  ${join(project, ".mcp.json")}`);
    expect(stdout).toContain("Codex   absent   no codex source in this item");
    expect(stdout).toContain(
      "Codex reads mcp/deepwiki/codex.toml in your data repo.",
    );
    expect(stdout).toContain(
      "Add it there, commit, then: capshelf update mcp/deepwiki",
    );
  });

  test("add of a two-source mcp item names both output files it wrote", async () => {
    const { project, run } = await fixture("coverage-add-both");

    const add = await run(["add", "mcp/github"]);
    expect(add.exitCode).toBe(0);
    const stdout = add.stdout.toString();
    expect(stdout).toContain(`Claude  written  ${join(project, ".mcp.json")}`);
    expect(stdout).toContain(
      `Codex   written  ${join(project, ".codex", "config.toml")}`,
    );
    expect(stdout).not.toContain("absent");
    expect(
      await readFile(join(project, ".codex", "config.toml"), "utf-8"),
    ).toContain("[mcp_servers.github]");
  });

  test("add of a one-target subagent names its canonical codex path", async () => {
    const { run } = await fixture("coverage-add-subagent");

    const add = await run(["add", "subagents/reviewer"]);
    expect(add.exitCode).toBe(0);
    const stdout = add.stdout.toString();
    expect(stdout).toContain("Codex   absent   no codex source in this item");
    expect(stdout).toContain(
      "Codex reads subagents/reviewer/codex.toml in your data repo.",
    );
  });

  test("a codex-only mcp item names the missing claude source, not the codex one", async () => {
    const { run } = await fixture("coverage-add-reverse");

    const add = await run(["add", "mcp/codexwiki"]);
    expect(add.exitCode).toBe(0);
    const stdout = add.stdout.toString();
    expect(stdout).toContain("Claude  absent   no claude source in this item");
    expect(stdout).toContain(
      "Claude reads mcp/codexwiki/claude.json in your data repo.",
    );
    expect(stdout).not.toContain("mcp/codexwiki/codex.toml in your data repo");
  });

  test("add --json carries targetCoverage and keeps dst and sources unchanged", async () => {
    const { project, run } = await fixture("coverage-add-json");

    const add = await run(["add", "mcp/deepwiki", "--json"]);
    expect(add.exitCode).toBe(0);
    const parsed = JSON.parse(add.stdout.toString());
    expect(parsed.targetCoverage).toEqual([
      {
        target: "claude",
        present: true,
        sourcePath: "mcp/deepwiki/claude.json",
        outputPath: ".mcp.json",
      },
      {
        target: "codex",
        present: false,
        sourcePath: "mcp/deepwiki/codex.toml",
        outputPath: ".codex/config.toml",
      },
    ]);
    expect(parsed.coverageState).toBeUndefined();
    // Retained keys are pinned, not merely promised: `dst` keeps its
    // first-surviving-target value and `sources` stays present-only.
    expect(parsed.dst).toBe(join(project, ".mcp.json"));
    expect(parsed.sources).toEqual([
      {
        target: "claude",
        sourcePath: "mcp/deepwiki/claude.json",
        outputPath: ".mcp.json",
        outputAction: "reconciled",
      },
    ]);

    const show = await run(["show", "mcp/deepwiki", "--json"]);
    expect(show.exitCode).toBe(0);
    const shown = JSON.parse(show.stdout.toString());
    expect(shown.sources).toEqual([
      {
        target: "claude",
        sourcePath: "mcp/deepwiki/claude.json",
        outputPath: ".mcp.json",
      },
    ]);
    expect(shown.targetCoverage).toHaveLength(2);
  });

  test("status --json keeps the subagent targets array beside targetCoverage", async () => {
    const { run } = await fixture("coverage-subagent-json");
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    const status = await run(["status", "subagents/reviewer", "--json"]);
    expect(status.exitCode).toBe(0);
    const row = JSON.parse(status.stdout.toString()).items[0];
    expect(row.targets).toEqual([
      {
        target: "claude",
        sourcePath: "subagents/reviewer/claude.md",
        outputPath: join(".claude", "agents", "reviewer.md"),
        state: "ok",
      },
    ]);
    expect(
      row.targetCoverage.map((r: { present: boolean }) => r.present),
    ).toEqual([true, false]);
  });

  test("status reports the gap and drops the Codex trust warning for a claude-only item", async () => {
    const { run } = await fixture("coverage-status-gap");
    const env = await codexEnv();
    expect((await run(["add", "mcp/deepwiki"], env)).exitCode).toBe(0);

    const status = await run(["status", "mcp/deepwiki"], env);
    expect(status.exitCode).toBe(0);
    const stdout = status.stdout.toString();
    expect(stdout).toContain(
      "targets: Claude ✓  Codex ✗ — no codex source at the locked commit",
    );
    expect(stdout).toContain(
      "Codex reads mcp/deepwiki/codex.toml; add it, commit, then: capshelf update mcp/deepwiki",
    );
    expect(stdout).not.toContain("Codex project config may be ignored");
  });

  test("status keeps the Codex trust warning and prints no gap for a two-source item", async () => {
    const { run } = await fixture("coverage-status-covered");
    const env = await codexEnv();
    expect((await run(["add", "mcp/github"], env)).exitCode).toBe(0);

    const status = await run(["status", "mcp/github"], env);
    expect(status.exitCode).toBe(0);
    const stdout = status.stdout.toString();
    expect(stdout).toContain("Codex project config may be ignored");
    expect(stdout).not.toContain("targets:");
  });

  test("coverage follows the lock, not the data repo worktree", async () => {
    const { dataRepo, run } = await fixture("coverage-follows-lock");
    expect((await run(["add", "mcp/deepwiki"])).exitCode).toBe(0);

    await writeMcpItem(dataRepo, "deepwiki", { claude: true, codex: true });
    await commitAll(dataRepo, "add the codex source upstream");

    const beforeShow = await run(["show", "mcp/deepwiki", "--no-content"]);
    expect(beforeShow.stdout.toString()).toContain(
      "Codex   absent   no codex source at the locked commit",
    );
    expect((await run(["status", "mcp/deepwiki"])).stdout.toString()).toContain(
      "targets: Claude ✓  Codex ✗",
    );

    expect((await run(["update", "mcp/deepwiki"])).exitCode).toBe(0);

    const afterShow = await run(["show", "mcp/deepwiki", "--no-content"]);
    expect(afterShow.stdout.toString()).toContain("Codex   present  ");
    expect(
      (await run(["status", "mcp/deepwiki"])).stdout.toString(),
    ).not.toContain("targets:");
  });

  test("an unreadable coverage state degrades instead of lying", async () => {
    const { project, dataRepo, run } = await fixture("coverage-degraded");
    const env = await codexEnv();
    expect((await run(["add", "mcp/deepwiki"], env)).exitCode).toBe(0);

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lock = JSON.parse(await readFile(lockPath, "utf-8"));
    lock.items["data/mcp/deepwiki"].sourceCommit = "0".repeat(40);
    await writeFile(lockPath, JSON.stringify(lock, null, 2));

    const unreachable = await run(["status", "mcp/deepwiki"], env);
    expect(unreachable.exitCode).toBe(0);
    expect(unreachable.stdout.toString()).toContain(
      "targets: unknown (locked commit unreachable)",
    );
    expect(unreachable.stdout.toString()).not.toContain("reads mcp/deepwiki");
    // Fail toward emitting: the gate removes a warning only on evidence.
    expect(unreachable.stdout.toString()).toContain(
      "Codex project config may be ignored",
    );
    const unreachableJson = JSON.parse(
      (await run(["status", "mcp/deepwiki", "--json"], env)).stdout.toString(),
    ).items[0];
    expect(
      unreachableJson.targetCoverage.map((r: { present: null }) => r.present),
    ).toEqual([null, null]);
    expect(unreachableJson.coverageState).toBe("unknown");

    // `add` on the already-installed branch builds its JSON independently.
    const readd = await run(["add", "mcp/deepwiki", "--json"], env);
    expect(readd.exitCode).toBe(0);
    const readdJson = JSON.parse(readd.stdout.toString());
    expect(readdJson.coverageState).toBe("unknown");
    expect(
      readdJson.targetCoverage.map((r: { present: null }) => r.present),
    ).toEqual([null, null]);

    const moved = `${dataRepo}-moved`;
    await rename(dataRepo, moved);
    try {
      const unbound = await run(["status", "mcp/deepwiki"], env);
      expect(unbound.exitCode).toBe(0);
      expect(unbound.stdout.toString()).toContain(
        "targets: unknown (data repo unbound)",
      );
      expect(unbound.stdout.toString()).toContain(
        "Codex project config may be ignored",
      );
    } finally {
      await rename(moved, dataRepo);
    }
  });

  test("an unreadable subagent tree degrades the row instead of exiting", async () => {
    const { dataRepo, run } = await fixture("coverage-unreadable-tree");
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    // The locked commit still resolves, so the unreachable-commit gate passes,
    // but its tree does not read. `subagentSourcesAtCommit` cannot tell that
    // from "this item has no sources" and throws.
    const tree = (
      await $`git -C ${dataRepo} rev-parse HEAD:subagents/reviewer`.text()
    ).trim();
    await rm(
      join(dataRepo, ".git", "objects", tree.slice(0, 2), tree.slice(2)),
      { force: true },
    );

    const status = await run(["status", "subagents/reviewer"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout.toString()).toContain(
      "targets: unknown (source tree unreadable)",
    );

    const row = JSON.parse(
      (await run(["status", "subagents/reviewer", "--json"])).stdout.toString(),
    ).items[0];
    expect(row.coverageState).toBe("unknown");
    // Omitted, not emptied: `targets: []` would claim the item has no targets.
    expect(row.targets).toBeUndefined();
  });

  test("an unreadable pinned blob still fails loudly", async () => {
    const { dataRepo, run } = await fixture("coverage-unreadable-blob");
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    // The tree enumerates — so coverage reads as known and fully covered —
    // but the pinned source cannot be read. `apply` cannot run in this state,
    // so `status` must not quietly drop `targets` and print a healthy row.
    const blob = (
      await $`git -C ${dataRepo} rev-parse HEAD:subagents/reviewer/claude.md`.text()
    ).trim();
    await rm(
      join(dataRepo, ".git", "objects", blob.slice(0, 2), blob.slice(2)),
      { force: true },
    );

    const status = await run(["status", "subagents/reviewer"]);
    expect(status.exitCode).not.toBe(0);
    expect(status.stdout.toString()).not.toContain("up-to-date");
  });

  test("show outside a project prints presence without a path or an update line", async () => {
    const { dataRepo } = await fixture("coverage-browse-only");
    const outside = await tempDir("capshelf-coverage-outside-");
    const run = runInProcess(outside);

    for (const ref of ["mcp/deepwiki", "subagents/reviewer"]) {
      const show = await run(["--data", dataRepo, "show", ref, "--no-content"]);
      expect(show.exitCode).toBe(0);
      const stdout = show.stdout.toString();
      expect(stdout).toContain("Claude  present  (no project)");
      expect(stdout).toContain("Codex   absent   no codex source in this item");
      expect(stdout).toContain(`Codex reads ${ref}/codex.toml`);
      expect(stdout).not.toContain("capshelf update");

      const json = JSON.parse(
        (
          await run(["--data", dataRepo, "show", ref, "--json"])
        ).stdout.toString(),
      );
      expect(
        json.targetCoverage.map((r: { outputPath: null }) => r.outputPath),
      ).toEqual([null, null]);
    }
  });

  test("show --target refuses a missing target and names its canonical path", async () => {
    const { run } = await fixture("coverage-show-target");
    expect((await run(["add", "mcp/deepwiki"])).exitCode).toBe(0);

    const refused = await run([
      "show",
      "mcp/deepwiki",
      "--target",
      "codex",
      "--no-content",
    ]);
    expect(refused.exitCode).toBe(3);
    const stderr = refused.stderr.toString();
    expect(stderr).toContain("mcp/deepwiki has no codex source");
    expect(stderr).toContain(
      "Codex reads mcp/deepwiki/codex.toml in your data repo.",
    );
    expect(stderr).toContain(
      "Add it there, commit, then: capshelf update mcp/deepwiki",
    );

    const claudeOnly = await run([
      "show",
      "mcp/deepwiki",
      "--target",
      "claude",
      "--no-content",
    ]);
    expect(claudeOnly.exitCode).toBe(0);
    expect(claudeOnly.stdout.toString()).toContain("Claude  present  ");
    expect(claudeOnly.stdout.toString()).not.toContain("Codex");
  });

  test("rm reports every reconciled output, not the first", async () => {
    const { project, run } = await fixture("coverage-rm");
    expect((await run(["add", "mcp/github"])).exitCode).toBe(0);

    const removed = await run(["rm", "mcp/github", "--yes", "--json"]);
    expect(removed.exitCode).toBe(0);
    const parsed = JSON.parse(removed.stdout.toString());
    expect(parsed.removedFiles).toBe(true);
    expect(parsed.path.split(", ")).toEqual([
      join(project, ".mcp.json"),
      join(project, ".codex", "config.toml"),
    ]);
  });

  test("share names the target the new item does not cover", async () => {
    const { project, dataRepo, run } = await fixture("coverage-share");
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { linear: { command: "linear-mcp" } } }),
    );
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await writeFile(
      join(project, ".claude", "agents", "auditor.md"),
      "---\nname: auditor\ndescription: audits changes\n---\nbody\n",
    );

    const fragment = await run(["share", "mcp/linear"]);
    expect(fragment.exitCode).toBe(0);
    const stdout = fragment.stdout.toString();
    expect(stdout).toContain("Codex   absent   no codex source in this item");
    expect(stdout).toContain(
      "Codex reads mcp/linear/codex.toml in your data repo.",
    );

    const subagent = await run(["share", "subagents/auditor", "--json"]);
    expect(subagent.exitCode).toBe(0);
    const subagentJson = JSON.parse(subagent.stdout.toString());
    expect(subagentJson.sources).toEqual([
      {
        target: "claude",
        sourcePath: "subagents/auditor/claude.md",
        outputPath: join(project, ".claude", "agents", "auditor.md"),
      },
    ]);
    expect(subagentJson.targetCoverage).toEqual([
      {
        target: "claude",
        present: true,
        sourcePath: "subagents/auditor/claude.md",
        outputPath: join(".claude", "agents", "auditor.md"),
      },
      {
        target: "codex",
        present: false,
        sourcePath: "subagents/auditor/codex.toml",
        outputPath: join(".codex", "agents", "auditor.toml"),
      },
    ]);
    expect(
      await readFile(
        join(dataRepo, "subagents", "auditor", "claude.md"),
        "utf-8",
      ),
    ).toContain("name: auditor");
  });

  test("single-target fragment kinds are unchanged, human and JSON", async () => {
    const { run } = await fixture("coverage-single-target");

    for (const ref of ["settings/base", "codex-config/defaults"]) {
      const add = await run(["add", ref]);
      expect(add.exitCode).toBe(0);
      expect(add.stdout.toString()).not.toContain("targets:");

      expect(
        JSON.parse((await run(["show", ref, "--json"])).stdout.toString())
          .targetCoverage,
      ).toBeUndefined();
      const row = JSON.parse(
        (await run(["status", ref, "--json"])).stdout.toString(),
      ).items[0];
      expect(row.targetCoverage).toBeUndefined();
      expect(
        (await run(["show", ref, "--no-content"])).stdout.toString(),
      ).not.toContain("targets:");
    }
  });
});
