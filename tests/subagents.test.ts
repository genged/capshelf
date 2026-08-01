import { $, file } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promoteSubagent } from "../src/commands/promote";
import {
  lastTouchingSubagentCommit,
  materializeSubagent,
  shaOfCurrentSubagent,
  validateSubagentSource,
} from "../src/subagents";
import { createDataLockEntry, loadLock } from "../src/lock";
import { emptyNeeds } from "../src/metadata";
import { commitAll, runInProcess, tempRepo } from "./cli-fixtures";

const CLAUDE = `---
name: reviewer
description: Review changes
---

Review the change carefully.
`;

const CODEX = `name = "reviewer"
description = "Review changes"
developer_instructions = "Review the change carefully."
model = "gpt-5.4"
`;

async function writeSubagent(
  dataRepo: string,
  options: { claude?: string; codex?: string } = {
    claude: CLAUDE,
    codex: CODEX,
  },
): Promise<void> {
  const root = join(dataRepo, "subagents", "reviewer");
  await mkdir(root, { recursive: true });
  if (options.claude !== undefined) {
    await writeFile(join(root, "claude.md"), options.claude);
  }
  if (options.codex !== undefined) {
    await writeFile(join(root, "codex.toml"), options.codex);
  }
}

describe("subagent validation and identity", () => {
  test("validates required runtime fields and warns on name mismatch", () => {
    expect(
      validateSubagentSource("claude", "reviewer", CLAUDE).warnings,
    ).toEqual([]);
    expect(validateSubagentSource("codex", "reviewer", CODEX).warnings).toEqual(
      [],
    );
    expect(() =>
      validateSubagentSource(
        "claude",
        "reviewer",
        "---\nname: reviewer\n---\n\nPrompt\n",
      ),
    ).toThrow("description must be a non-empty string");
    for (const invalid of [
      "Prompt without frontmatter\n",
      "---\ndescription: Review\n---\n\nPrompt\n",
      "---\nname: reviewer\n---\n\nPrompt\n",
      "---\nname: reviewer\ndescription: Review\n---\n\n",
    ]) {
      expect(() =>
        validateSubagentSource("claude", "reviewer", invalid),
      ).toThrow();
    }
    expect(() =>
      validateSubagentSource(
        "codex",
        "reviewer",
        'name = "reviewer"\ndescription = "Review"\n',
      ),
    ).toThrow("developer_instructions must be a non-empty string");
    for (const invalid of [
      'name = ["unterminated"\n',
      'description = "Review"\ndeveloper_instructions = "Prompt"\n',
      'name = "reviewer"\ndeveloper_instructions = "Prompt"\n',
      'name = "reviewer"\ndescription = "Review"\ndeveloper_instructions = ""\n',
    ]) {
      expect(() =>
        validateSubagentSource("codex", "reviewer", invalid),
      ).toThrow();
    }
    expect(
      validateSubagentSource(
        "codex",
        "reviewer",
        CODEX.replace('name = "reviewer"', 'name = "other"'),
      ).warnings,
    ).toEqual([
      'subagents/reviewer: Codex name "other" differs from item name',
    ]);
  });

  test("hashes canonical targets and ignores metadata and unrelated files", async () => {
    const dataRepo = await tempRepo("capshelf-subagent-hash-");
    await writeSubagent(dataRepo);
    const before = await shaOfCurrentSubagent("", dataRepo, "reviewer");
    await writeFile(
      join(dataRepo, "subagents", "reviewer", ".capshelf.yml"),
      "tags: [review]\n",
    );
    await writeFile(
      join(dataRepo, "subagents", "reviewer", "README.md"),
      "catalog notes\n",
    );
    expect(await shaOfCurrentSubagent("", dataRepo, "reviewer")).toBe(before);
    await writeFile(
      join(dataRepo, "subagents", "reviewer", "codex.toml"),
      CODEX.replace("carefully", "strictly"),
    );
    expect(await shaOfCurrentSubagent("", dataRepo, "reviewer")).not.toBe(
      before,
    );
  });

  test("content provenance ignores metadata but records target deletion", async () => {
    const dataRepo = await tempRepo("capshelf-subagent-commit-");
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");
    const initial = await lastTouchingSubagentCommit("", dataRepo, "reviewer");
    await writeFile(
      join(dataRepo, "subagents", "reviewer", ".capshelf.yml"),
      "tags: [review]\n",
    );
    await commitAll(dataRepo, "catalog metadata");
    expect(await lastTouchingSubagentCommit("", dataRepo, "reviewer")).toBe(
      initial,
    );
    await rm(join(dataRepo, "subagents", "reviewer", "codex.toml"));
    await commitAll(dataRepo, "remove Codex target");
    expect(await lastTouchingSubagentCommit("", dataRepo, "reviewer")).toBe(
      (await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim(),
    );
  });

  test("rolls every output back when a later target replacement fails", async () => {
    const project = await tempRepo("capshelf-subagent-atomic-project-");
    const dataRepo = await tempRepo("capshelf-subagent-atomic-data-");
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "reviewer v1");
    const firstCommit = await lastTouchingSubagentCommit(
      project,
      dataRepo,
      "reviewer",
    );
    const firstEntry = createDataLockEntry({
      sha: await shaOfCurrentSubagent(project, dataRepo, "reviewer"),
      sourceCommit: firstCommit,
      needs: emptyNeeds(),
      needsSourceCommit: firstCommit,
    });
    await materializeSubagent({
      project,
      dataRepo,
      name: "reviewer",
      entry: firstEntry,
    });

    await writeSubagent(dataRepo, {
      claude: CLAUDE.replace("carefully", "strictly"),
      codex: CODEX.replace("carefully", "strictly"),
    });
    await commitAll(dataRepo, "reviewer v2");
    const secondCommit = await lastTouchingSubagentCommit(
      project,
      dataRepo,
      "reviewer",
    );
    const secondEntry = createDataLockEntry({
      sha: await shaOfCurrentSubagent(project, dataRepo, "reviewer"),
      sourceCommit: secondCommit,
      needs: emptyNeeds(),
      needsSourceCommit: secondCommit,
    });

    await expect(
      materializeSubagent({
        project,
        dataRepo,
        name: "reviewer",
        entry: secondEntry,
        previousEntry: firstEntry,
        hooks: {
          beforeReplace: (_source, index) => {
            if (index === 1) throw new Error("injected second-target failure");
          },
        },
      }),
    ).rejects.toThrow("injected second-target failure");
    expect(
      await file(join(project, ".claude", "agents", "reviewer.md")).text(),
    ).toBe(CLAUDE);
    expect(
      await file(join(project, ".codex", "agents", "reviewer.toml")).text(),
    ).toBe(CODEX);
  });

  test("refuses a hostile stale output before replacing desired siblings", async () => {
    const project = await tempRepo("capshelf-subagent-stale-project-");
    const dataRepo = await tempRepo("capshelf-subagent-stale-data-");
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "reviewer v1");
    const firstCommit = await lastTouchingSubagentCommit(
      project,
      dataRepo,
      "reviewer",
    );
    const firstEntry = createDataLockEntry({
      sha: await shaOfCurrentSubagent(project, dataRepo, "reviewer"),
      sourceCommit: firstCommit,
      needs: emptyNeeds(),
      needsSourceCommit: firstCommit,
    });
    await materializeSubagent({
      project,
      dataRepo,
      name: "reviewer",
      entry: firstEntry,
    });
    const claudeOutput = join(project, ".claude", "agents", "reviewer.md");
    const codexOutput = join(project, ".codex", "agents", "reviewer.toml");
    await rm(codexOutput);
    await mkdir(codexOutput);
    await writeFile(join(codexOutput, "sentinel"), "untouched\n");

    await rm(join(dataRepo, "subagents", "reviewer", "codex.toml"));
    await writeFile(
      join(dataRepo, "subagents", "reviewer", "claude.md"),
      CLAUDE.replace("carefully", "strictly"),
    );
    await commitAll(dataRepo, "reviewer v2");
    const secondCommit = await lastTouchingSubagentCommit(
      project,
      dataRepo,
      "reviewer",
    );
    const secondEntry = createDataLockEntry({
      sha: await shaOfCurrentSubagent(project, dataRepo, "reviewer"),
      sourceCommit: secondCommit,
      needs: emptyNeeds(),
      needsSourceCommit: secondCommit,
    });
    let replacementAttempted = false;

    await expect(
      materializeSubagent({
        project,
        dataRepo,
        name: "reviewer",
        entry: secondEntry,
        previousEntry: firstEntry,
        hooks: {
          beforeReplace: () => {
            replacementAttempted = true;
          },
        },
      }),
    ).rejects.toThrow("managed subagent target is not a regular file");
    expect(replacementAttempted).toBe(false);
    expect(await file(claudeOutput).text()).toBe(CLAUDE);
    expect((await lstat(codexOutput)).isDirectory()).toBe(true);
    expect(await file(join(codexOutput, "sentinel")).text()).toBe(
      "untouched\n",
    );
  });
});

describe("subagent CLI lifecycle", () => {
  test("adds, reports drift, reverts, updates target removal, and removes all outputs", async () => {
    const project = await tempRepo("capshelf-subagent-project-");
    const dataRepo = await tempRepo("capshelf-subagent-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");

    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);
    const claudeOutput = join(project, ".claude", "agents", "reviewer.md");
    const codexOutput = join(project, ".codex", "agents", "reviewer.toml");
    expect(await file(claudeOutput).text()).toBe(CLAUDE);
    expect(await file(codexOutput).text()).toBe(CODEX);

    const lock = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).json();
    expect(lock.items["data/subagents/reviewer"]).toBeDefined();
    const manifest = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).json();
    expect(manifest.subagents).toEqual(["reviewer"]);

    const humanStatus = await run(["status", "subagents/reviewer"]);
    expect(humanStatus.exitCode).toBe(0);
    expect(humanStatus.stdout.toString()).toContain("subagents/reviewer");
    const jsonStatus = await run(["status", "subagents/reviewer", "--json"]);
    expect(jsonStatus.exitCode).toBe(0);
    expect(JSON.parse(jsonStatus.stdout.toString()).items[0].targets).toEqual([
      {
        target: "claude",
        sourcePath: "subagents/reviewer/claude.md",
        outputPath: ".claude/agents/reviewer.md",
        state: "ok",
      },
      {
        target: "codex",
        sourcePath: "subagents/reviewer/codex.toml",
        outputPath: ".codex/agents/reviewer.toml",
        state: "ok",
      },
    ]);

    await rm(claudeOutput);
    expect((await run(["apply", "subagents/reviewer"])).exitCode).toBe(0);
    expect(await file(claudeOutput).text()).toBe(CLAUDE);

    await writeFile(claudeOutput, CLAUDE.replace("carefully", "strictly"));
    const drifted = await run(["status", "subagents/reviewer", "--json"]);
    expect(drifted.exitCode).toBe(0);
    expect(JSON.parse(drifted.stdout.toString()).items[0].state).toBe(
      "drifted_local",
    );
    expect((await run(["revert", "subagents/reviewer"])).exitCode).toBe(0);
    expect(await file(claudeOutput).text()).toBe(CLAUDE);
    expect((await run(["keep-local", "subagents/reviewer"])).exitCode).toBe(3);

    const canonicalCodex = join(
      dataRepo,
      "subagents",
      "reviewer",
      "codex.toml",
    );
    await rm(canonicalCodex);
    const dirtyDeletion = await run(["status", "subagents/reviewer", "--json"]);
    expect(dirtyDeletion.exitCode).toBe(0);
    expect(JSON.parse(dirtyDeletion.stdout.toString()).items[0].state).toBe(
      "upstream_dirty",
    );
    expect((await run(["update", "subagents/reviewer"])).exitCode).toBe(3);
    await writeFile(canonicalCodex, CODEX);

    await rm(join(dataRepo, "subagents", "reviewer", "codex.toml"));
    await writeFile(
      join(dataRepo, "subagents", "reviewer", "claude.md"),
      CLAUDE.replace("carefully", "thoroughly"),
    );
    await commitAll(dataRepo, "make reviewer Claude only");
    expect((await run(["update", "subagents/reviewer"])).exitCode).toBe(0);
    expect(await file(claudeOutput).text()).toContain("thoroughly");
    expect(existsSync(codexOutput)).toBe(false);
    const singlePath = await run(["get-path", "subagents/reviewer"]);
    expect(singlePath.exitCode).toBe(0);
    expect(singlePath.stdout.toString().trim()).toBe(
      join(dataRepo, "subagents", "reviewer", "claude.md"),
    );

    expect((await run(["rm", "subagents/reviewer"])).exitCode).toBe(0);
    expect(existsSync(claudeOutput)).toBe(false);
  });

  test("refuses unmanaged collisions at either runtime output", async () => {
    const dataRepo = await tempRepo("capshelf-subagent-refuse-data-");
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");
    for (const target of [
      {
        directory: [".claude", "agents"],
        filename: "reviewer.md",
        content: CLAUDE,
      },
      {
        directory: [".codex", "agents"],
        filename: "reviewer.toml",
        content: CODEX,
      },
    ]) {
      const project = await tempRepo("capshelf-subagent-refuse-project-");
      const run = runInProcess(project);
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      const manifestBefore = await file(
        join(project, ".capshelf", "capshelf.json"),
      ).text();
      const lockBefore = await file(
        join(project, ".capshelf", "capshelf.lock.json"),
      ).text();
      const directory = join(project, ...target.directory);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, target.filename), target.content);
      expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(3);
      expect(
        await file(join(project, ".capshelf", "capshelf.json")).text(),
      ).toBe(manifestBefore);
      expect(
        await file(join(project, ".capshelf", "capshelf.lock.json")).text(),
      ).toBe(lockBefore);
    }
  });

  test("rejects partial and local lifecycles before writing", async () => {
    const project = await tempRepo("capshelf-subagent-options-project-");
    const dataRepo = await tempRepo("capshelf-subagent-options-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    const manifestBefore = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).text();
    const lockBefore = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).text();

    expect(
      (await run(["add", "subagents/reviewer", "--target", "codex"])).exitCode,
    ).toBe(3);
    expect((await run(["add", "subagents/reviewer", "--local"])).exitCode).toBe(
      3,
    );
    expect(await file(join(project, ".capshelf", "capshelf.json")).text()).toBe(
      manifestBefore,
    );
    expect(
      await file(join(project, ".capshelf", "capshelf.lock.json")).text(),
    ).toBe(lockBefore);
    expect(existsSync(join(project, ".claude", "agents", "reviewer.md"))).toBe(
      false,
    );
    expect(existsSync(join(project, ".codex", "agents", "reviewer.toml"))).toBe(
      false,
    );
  });

  test("rejects malformed sources without changing project state", async () => {
    const project = await tempRepo("capshelf-subagent-invalid-project-");
    const dataRepo = await tempRepo("capshelf-subagent-invalid-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo, {
      claude: "---\nname: reviewer\n---\n\nPrompt\n",
    });
    await commitAll(dataRepo, "add malformed reviewer");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    const manifestBefore = await file(
      join(project, ".capshelf", "capshelf.json"),
    ).text();
    const lockBefore = await file(
      join(project, ".capshelf", "capshelf.lock.json"),
    ).text();
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(3);
    expect(await file(join(project, ".capshelf", "capshelf.json")).text()).toBe(
      manifestBefore,
    );
    expect(
      await file(join(project, ".capshelf", "capshelf.lock.json")).text(),
    ).toBe(lockBefore);
    expect(existsSync(join(project, ".claude", "agents", "reviewer.md"))).toBe(
      false,
    );
  });

  test("shares both runtime outputs and promotes only the edited sibling", async () => {
    const project = await tempRepo("capshelf-subagent-share-project-");
    const dataRepo = await tempRepo("capshelf-subagent-share-data-");
    const run = runInProcess(project);
    await writeFile(join(dataRepo, ".gitkeep"), "");
    await commitAll(dataRepo, "baseline");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const claudeOutput = join(project, ".claude", "agents", "reviewer.md");
    const codexOutput = join(project, ".codex", "agents", "reviewer.toml");
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await mkdir(join(project, ".codex", "agents"), { recursive: true });
    await writeFile(claudeOutput, CLAUDE);
    await writeFile(codexOutput, CODEX);

    expect(
      (
        await run([
          "share",
          "subagents/reviewer",
          "--from",
          claudeOutput,
          "--to",
          "project",
        ])
      ).exitCode,
    ).toBe(3);
    expect(
      existsSync(join(dataRepo, "subagents", "reviewer", "claude.md")),
    ).toBe(false);
    await writeFile(codexOutput, 'name = "reviewer"\n');
    expect(
      (
        await run([
          "share",
          "subagents/reviewer",
          "--to",
          "project",
          "-m",
          "invalid reviewer",
        ])
      ).exitCode,
    ).toBe(3);
    expect(existsSync(join(dataRepo, "subagents", "reviewer"))).toBe(false);
    await writeFile(codexOutput, CODEX);

    expect(
      (
        await run([
          "share",
          "subagents/reviewer",
          "--to",
          "project",
          "-m",
          "share reviewer",
        ])
      ).exitCode,
    ).toBe(0);
    const canonicalClaude = join(
      dataRepo,
      "subagents",
      "reviewer",
      "claude.md",
    );
    const canonicalCodex = join(
      dataRepo,
      "subagents",
      "reviewer",
      "codex.toml",
    );
    expect(await file(canonicalClaude).text()).toBe(CLAUDE);
    expect(await file(canonicalCodex).text()).toBe(CODEX);

    await writeFile(
      claudeOutput,
      CLAUDE.replace("carefully", "with security focus"),
    );
    const codexBefore = await file(canonicalCodex).text();
    const claudeBefore = await file(canonicalClaude).text();
    const headBefore = (
      await $`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    expect(
      (await run(["promote", "subagents/reviewer", "--merge", "-m", "no"]))
        .exitCode,
    ).toBe(3);
    expect(await file(canonicalClaude).text()).toBe(claudeBefore);
    expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );

    expect(
      (await run(["promote", "subagents/reviewer", "-m", "tighten reviewer"]))
        .exitCode,
    ).toBe(0);
    expect(await file(canonicalClaude).text()).toContain("security focus");
    expect(await file(canonicalCodex).text()).toBe(codexBefore);

    const validPromotedClaude = await file(canonicalClaude).text();
    await writeFile(claudeOutput, "---\nname: reviewer\n---\n\nPrompt\n");
    expect(
      (await run(["promote", "subagents/reviewer", "-m", "invalid reviewer"]))
        .exitCode,
    ).toBe(3);
    expect(await file(canonicalClaude).text()).toBe(validPromotedClaude);

    await writeFile(
      canonicalClaude,
      CLAUDE.replace("carefully", "with upstream policy"),
    );
    await commitAll(dataRepo, "advance reviewer upstream");
    await writeFile(
      claudeOutput,
      CLAUDE.replace("carefully", "with local policy"),
    );
    expect(
      (await run(["promote", "subagents/reviewer", "-m", "stale reviewer"]))
        .exitCode,
    ).toBe(3);
    expect(await file(canonicalClaude).text()).toContain("upstream policy");
    expect(
      (
        await run([
          "promote",
          "subagents/reviewer",
          "--stale-ok",
          "-m",
          "override stale reviewer",
        ])
      ).exitCode,
    ).toBe(0);
    expect(await file(canonicalClaude).text()).toContain("local policy");
    expect(await file(canonicalCodex).text()).toBe(codexBefore);
  });

  test("refuses a missing managed output instead of reporting promote current", async () => {
    const project = await tempRepo("capshelf-subagent-missing-project-");
    const dataRepo = await tempRepo("capshelf-subagent-missing-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    const canonicalClaude = join(
      dataRepo,
      "subagents",
      "reviewer",
      "claude.md",
    );
    const canonicalCodex = join(
      dataRepo,
      "subagents",
      "reviewer",
      "codex.toml",
    );
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const claudeBefore = await file(canonicalClaude).text();
    const codexBefore = await file(canonicalCodex).text();
    const lockBefore = await file(lockPath).text();
    const headBefore = (
      await $`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    await rm(join(project, ".codex", "agents", "reviewer.toml"));

    const result = await run(["promote", "subagents/reviewer"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "capshelf revert subagents/reviewer",
    );
    expect(result.stderr.toString()).toContain(
      "capshelf update subagents/reviewer",
    );
    expect(await file(canonicalClaude).text()).toBe(claudeBefore);
    expect(await file(canonicalCodex).text()).toBe(codexBefore);
    expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("validates the projected canonical sibling set before promote writes", async () => {
    const project = await tempRepo("capshelf-subagent-projection-project-");
    const dataRepo = await tempRepo("capshelf-subagent-projection-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo);
    await commitAll(dataRepo, "add reviewer");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
    expect((await run(["add", "subagents/reviewer"])).exitCode).toBe(0);

    const claudeOutput = join(project, ".claude", "agents", "reviewer.md");
    const canonicalClaude = join(
      dataRepo,
      "subagents",
      "reviewer",
      "claude.md",
    );
    const canonicalCodex = join(
      dataRepo,
      "subagents",
      "reviewer",
      "codex.toml",
    );
    await writeFile(
      claudeOutput,
      CLAUDE.replace("carefully", "with security focus"),
    );
    await writeFile(
      canonicalCodex,
      'name = "reviewer"\ndescription = "Review changes"\n',
    );
    await commitAll(dataRepo, "break Codex reviewer upstream");

    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const lock = await loadLock(project);
    const lockBefore = await file(lockPath).text();
    const claudeBefore = await file(canonicalClaude).text();
    const codexBefore = await file(canonicalCodex).text();
    const headBefore = (
      await $`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();
    let mutationAttempted = false;

    await expect(
      promoteSubagent(project, dataRepo, lock, "reviewer", {
        staleOk: true,
        beforeCanonicalWrite: async () => {
          mutationAttempted = true;
          throw new Error("canonical write attempted");
        },
      }),
    ).rejects.toThrow("developer_instructions must be a non-empty string");
    expect(mutationAttempted).toBe(false);
    expect(await file(canonicalClaude).text()).toBe(claudeBefore);
    expect(await file(canonicalCodex).text()).toBe(codexBefore);
    expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("refuses a symlink during default share scanning without writes", async () => {
    const project = await tempRepo("capshelf-subagent-share-link-project-");
    const dataRepo = await tempRepo("capshelf-subagent-share-link-data-");
    const run = runInProcess(project);
    await writeFile(join(dataRepo, ".gitkeep"), "");
    await commitAll(dataRepo, "baseline");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    const source = join(project, "reviewer-source.md");
    const output = join(project, ".claude", "agents", "reviewer.md");
    await writeFile(source, CLAUDE);
    await mkdir(join(project, ".claude", "agents"), { recursive: true });
    await symlink(source, output);
    const manifestPath = join(project, ".capshelf", "capshelf.json");
    const lockPath = join(project, ".capshelf", "capshelf.lock.json");
    const manifestBefore = await file(manifestPath).text();
    const lockBefore = await file(lockPath).text();
    const headBefore = (
      await $`git -C ${dataRepo} rev-parse HEAD`.text()
    ).trim();

    const result = await run([
      "share",
      "subagents/reviewer",
      "--to",
      "project",
    ]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "runtime target is not a regular file",
    );
    expect((await lstat(output)).isSymbolicLink()).toBe(true);
    expect(await file(source).text()).toBe(CLAUDE);
    expect(existsSync(join(dataRepo, "subagents", "reviewer"))).toBe(false);
    expect((await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim()).toBe(
      headBefore,
    );
    expect(await file(manifestPath).text()).toBe(manifestBefore);
    expect(await file(lockPath).text()).toBe(lockBefore);
  });

  test("supports discovery, target-aware paths, and bundle expansion", async () => {
    const project = await tempRepo("capshelf-subagent-bundle-project-");
    const dataRepo = await tempRepo("capshelf-subagent-bundle-data-");
    const run = runInProcess(project);
    await writeSubagent(dataRepo);
    await mkdir(join(dataRepo, "subagents", "claude-only"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "subagents", "claude-only", "claude.md"),
      CLAUDE.replaceAll("reviewer", "claude-only"),
    );
    await mkdir(join(dataRepo, "subagents", "codex-only"), {
      recursive: true,
    });
    await writeFile(
      join(dataRepo, "subagents", "codex-only", "codex.toml"),
      CODEX.replaceAll("reviewer", "codex-only"),
    );
    await mkdir(join(dataRepo, "subagents", "empty"), { recursive: true });
    await writeFile(
      join(dataRepo, "subagents", "empty", "README.md"),
      "not a runtime target\n",
    );
    await mkdir(join(dataRepo, "bundles"), { recursive: true });
    await writeFile(
      join(dataRepo, "bundles", "review.yml"),
      "includes:\n  subagents: [reviewer]\n",
    );
    await commitAll(dataRepo, "add reviewer bundle");
    expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);

    expect(
      (await run(["ls", "--kind", "subagents"])).stdout.toString(),
    ).toContain("subagents/reviewer");
    const listing = (
      await run(["ls", "--kind", "subagents"])
    ).stdout.toString();
    expect(listing).toContain("subagents/claude-only");
    expect(listing).toContain("subagents/codex-only");
    expect(listing).not.toContain("subagents/empty");
    expect((await run(["search", "carefully"])).stdout.toString()).toContain(
      "subagents/reviewer",
    );
    expect((await run(["add", "bundles/review", "--local"])).exitCode).toBe(3);
    expect(existsSync(join(project, ".claude", "agents", "reviewer.md"))).toBe(
      false,
    );
    expect((await run(["add", "bundles/review"])).exitCode).toBe(0);

    expect((await run(["get-path", "subagents/reviewer"])).exitCode).toBe(3);
    const getPath = await run([
      "get-path",
      "subagents/reviewer",
      "--target",
      "codex",
      "--output",
    ]);
    expect(getPath.exitCode).toBe(0);
    expect(getPath.stdout.toString().trim()).toBe(
      join(project, ".codex", "agents", "reviewer.toml"),
    );
    const show = await run([
      "show",
      "subagents/reviewer",
      "--target",
      "claude",
    ]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout.toString()).toContain("claude.md");
    expect(show.stdout.toString()).not.toContain("codex.toml");
    const showJson = await run(["show", "subagents/reviewer", "--json"]);
    expect(showJson.exitCode).toBe(0);
    expect(
      JSON.parse(showJson.stdout.toString()).sources.map(
        (source: { target: string }) => source.target,
      ),
    ).toEqual(["claude", "codex"]);
  });
});
