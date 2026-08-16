import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allCanonicalItemRelPaths } from "../src/master";
import { pinItemAtCommit } from "../src/pin";
import { subagentCandidates, subagentSourceCandidates } from "../src/subagents";
import {
  itemTargetCoverageAtCommit,
  itemTargetCoverageInPaths,
} from "../src/target-coverage";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

describe("target coverage", () => {
  test("the project-less candidate list agrees with the two that need a project", () => {
    // `subagentCandidates` exists so presence can be read without a project.
    // A second definition of the canonical paths is a drift risk, so the three
    // that name them are pinned against each other here rather than by care.
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
    // One candidate target: no coverage to report.
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
    await mkdir(join(dataRepo, "mcp", "deepwiki"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "deepwiki", "claude.json"),
      JSON.stringify({ mcpServers: { deepwiki: { command: "deepwiki-mcp" } } }),
    );
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

    // Drop the item's tree object. The commit still resolves — so the
    // "locked commit unreachable" gate passes — but its content cannot be
    // read. Probing each canonical path with `git show` cannot tell that
    // apart from a genuinely missing file and would report a known absence,
    // which is what suppresses the Codex trust warning.
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
    await mkdir(join(dataRepo, "mcp", "deepwiki"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "deepwiki", "claude.json"),
      JSON.stringify({ mcpServers: { deepwiki: { command: "deepwiki-mcp" } } }),
    );
    // Git stores this as a blob with mode 120000, so an object-type filter
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
    // Coverage must never promise a target the pin refuses to name.
    expect(pinItemAtCommit(dataRepo, "mcp", "deepwiki", head)).rejects.toThrow(
      /unsupported Git entry/,
    );
  });

  test("an unreachable commit is unknown before any tree read is attempted", async () => {
    const dataRepo = await tempRepo("capshelf-coverage-unreachable-", {
      origin: null,
    });
    await mkdir(join(dataRepo, "mcp", "deepwiki"), { recursive: true });
    await writeFile(
      join(dataRepo, "mcp", "deepwiki", "claude.json"),
      JSON.stringify({ mcpServers: { deepwiki: { command: "deepwiki-mcp" } } }),
    );
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
