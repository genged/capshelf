import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitTreeSource } from "../src/item-source";
import { allCanonicalItemRelPaths } from "../src/master";
import { pinItemAtCommit } from "../src/pin";
import { subagentCandidates, subagentSourceCandidates } from "../src/subagents";
import {
  itemTargetCoverageAtCommit,
  itemTargetCoverageInPaths,
} from "../src/target-coverage";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

describe("target coverage", () => {
  async function writeClaudeOnlyMcp(dataRepo: string): Promise<void> {
    await mkdir(join(dataRepo, "mcp", "deepwiki"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "deepwiki", "claude.json"),
      JSON.stringify({ mcpServers: { deepwiki: { command: "deepwiki-mcp" } } }),
    );
  }

  test("the project-less candidate list agrees with the two that need a project", () => {
    // A second definition of the canonical paths risks drift, so the three that
    // name them are pinned against each other.
    expect(subagentCandidates("reviewer").map((c) => c.relPath)).toEqual(
      allCanonicalItemRelPaths("subagents", "reviewer"),
    );
    expect(
      subagentSourceCandidates("/tmp/project", "reviewer").map(
        (source) => source.relPath,
      ),
    ).toEqual(allCanonicalItemRelPaths("subagents", "reviewer"));
  });

  test("coverage from a tree listing marks the candidate the tree lacks", () => {
    expect(
      itemTargetCoverageInPaths(null, "mcp", "deepwiki", [
        "mcp/deepwiki/claude.json",
      ])?.rows.map((row) => [row.target, row.present]),
    ).toEqual([
      ["claude", true],
      ["codex", false],
    ]);
    expect(
      itemTargetCoverageInPaths(null, "subagents", "reviewer", [
        "subagents/reviewer/codex.toml",
      ])?.rows.map((row) => [row.target, row.present]),
    ).toEqual([
      ["claude", false],
      ["codex", true],
    ]);
    expect(
      itemTargetCoverageInPaths(null, "settings", "base", [
        "settings/base/settings.json",
      ]),
    ).toBeNull();
  });

  test("a failed tree read is unknown coverage, not an absent source", async () => {
    const dataRepo = await tempRepo("capshelf-coverage-unreadable-", {
      origin: null,
    });
    await writeClaudeOnlyMcp(dataRepo);
    await commitAll(dataRepo, "claude only");
    const head = (await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim();

    const readable = await itemTargetCoverageAtCommit(
      null,
      dataRepo,
      "mcp",
      "deepwiki",
      head,
    );
    expect(readable?.state).toBe("known");
    expect(readable?.rows.map((row) => row.present)).toEqual([true, false]);

    // With the tree object dropped the commit still resolves but its content is
    // unreadable; probing paths with `git show` would misreport a known
    // absence, suppressing the Codex trust warning.
    const tree = (
      await $`git -C ${dataRepo} rev-parse HEAD:mcp/deepwiki`.text()
    ).trim();
    await rm(
      join(dataRepo, ".git", "objects", tree.slice(0, 2), tree.slice(2)),
      { force: true },
    );

    const unreadable = await itemTargetCoverageAtCommit(
      null,
      dataRepo,
      "mcp",
      "deepwiki",
      head,
    );
    expect(unreadable?.state).toBe("unknown");
    expect(unreadable?.reason).toBe("source tree unreadable");
    expect(unreadable?.rows.map((row) => row.present)).toEqual([null, null]);
  });

  test("a committed symlink at a canonical path is not a covered target", async () => {
    const dataRepo = await tempRepo("capshelf-coverage-symlink-", {
      origin: null,
    });
    await writeClaudeOnlyMcp(dataRepo);
    // Git stores a symlink as a blob with mode 120000, so an object-type filter
    // would count it as a Codex source.
    await symlink(
      "claude.json",
      join(dataRepo, "mcp", "deepwiki", "codex.toml"),
    );
    await commitAll(dataRepo, "codex.toml as a symlink");
    const head = (await $`git -C ${dataRepo} rev-parse HEAD`.text()).trim();

    const report = await itemTargetCoverageAtCommit(
      null,
      dataRepo,
      "mcp",
      "deepwiki",
      head,
    );
    expect(report?.state).toBe("known");
    expect(report?.rows.map((row) => row.present)).toEqual([true, false]);
    expect(
      pinItemAtCommit(
        gitTreeSource({
          repo: dataRepo,
          kind: "mcp",
          name: "deepwiki",
          commit: head,
        }),
        "mcp",
        "deepwiki",
      ),
    ).rejects.toThrow(/unsupported Git entry/);
  });

  test("an unreachable commit is unknown before any tree read is attempted", async () => {
    const dataRepo = await tempRepo("capshelf-coverage-unreachable-", {
      origin: null,
    });
    await writeClaudeOnlyMcp(dataRepo);
    await commitAll(dataRepo, "claude only");

    const report = await itemTargetCoverageAtCommit(
      await tempDir("capshelf-coverage-project-"),
      dataRepo,
      "mcp",
      "deepwiki",
      "0".repeat(40),
    );
    expect(report?.state).toBe("unknown");
    expect(report?.reason).toBe("locked commit unreachable");
    expect(report?.rows.map((row) => row.present)).toEqual([null, null]);
  });
});
