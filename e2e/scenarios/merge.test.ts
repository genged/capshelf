import { expect, test } from "bun:test";
import { join } from "node:path";
import type { OwnedState } from "../support/assertions";
import {
  captureOwnedState,
  expectBytes,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { asBoolean, asObject, asString, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

/**
 * Merge writes content neither side authored, so it may touch only the
 * installed copy and lock, never the data repo; a quiet publish or half-written
 * conflict would lose work found nowhere else.
 */
const SCENARIO = "merge";

interface MergeRow {
  action: string;
  merged?: boolean;
  mergeBase?: string;
  mergedUpstreamCommit?: string;
}

/**
 * Rows report `action`, not `state`, so the shared status parser rejects them.
 */
function mergeRow(stdout: string): MergeRow {
  const payload = asObject(
    parseJsonText(stdout, "update --json"),
    "update --json",
  );
  const items = payload.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`update --json has no items: ${stdout}`);
  }
  const first = asObject(items[0], "update row");
  const row: MergeRow = { action: asString(first.action, "action") };
  if (first.merged !== undefined)
    row.merged = asBoolean(first.merged, "merged");
  if (first.mergeBase !== undefined) {
    row.mergeBase = asString(first.mergeBase, "mergeBase");
  }
  if (first.mergedUpstreamCommit !== undefined) {
    row.mergedUpstreamCommit = asString(
      first.mergedUpstreamCommit,
      "mergedUpstreamCommit",
    );
  }
  return row;
}

const HEAD = "---\nname: hello\ndescription: Greet.\n---\n\n";
const BASE = `${HEAD}alpha\nbeta\ngamma\n`;
const UPSTREAM = `${HEAD}alpha\nbeta\nGAMMA-upstream\n`;
const LOCAL = `${HEAD}ALPHA-local\nbeta\ngamma\n`;
const MERGED = `${HEAD}ALPHA-local\nbeta\nGAMMA-upstream\n`;

test(
  "update --merge combines both edits into the installed copy and leaves the shelf alone",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with upstream and the project editing different regions, update --merge writes the combined result to the installed copy, pins the lock to upstream, creates no data-repo commit, names the base and upstream commits it used, and leaves the item reported as local drift until a later promote",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the merge is a Git three-way content merge, so this proves the text capshelf produces, not that the merged skill is semantically correct",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        skills: { hello: BASE },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "skills/hello"]), 0);

      const baseCommit = await world.git.head(shelf);
      const upstreamCommit = await world.git.writeAndCommit(
        shelf,
        { "skills/hello/SKILL.md": UPSTREAM },
        "upstream edits gamma",
      );
      const installed = join(project, ".agents", "skills", "hello", "SKILL.md");
      await world.git.writeFiles(project, {
        ".agents/skills/hello/SKILL.md": LOCAL,
      });

      const merged = await world.capshelf(project, [
        "update",
        "skills/hello",
        "--merge",
        "--json",
      ]);
      expectExit(merged, 0);
      const row = mergeRow(merged.stdout);
      expect(row.action).toBe("merged");
      expect(row.merged).toBe(true);
      // Full commits, since an abbreviation can become ambiguous as the repo
      // grows.
      expect(row.mergeBase).toBe(baseCommit);
      expect(row.mergedUpstreamCommit).toBe(upstreamCommit);

      await expectBytes(installed, MERGED);

      expect(await world.git.head(shelf)).toBe(upstreamCommit);
      expect(await world.git.isCleanWorktree(shelf)).toBe(true);
      expect(
        await Bun.file(join(shelf, "skills", "hello", "SKILL.md")).text(),
      ).toBe(UPSTREAM);

      expect(
        statusRow(
          parseStatusRows(
            (await world.capshelf(project, ["status", "--json"])).stdout,
          ),
          "skills",
          "hello",
        ).state,
      ).toBe("drifted_local");

      // The repeat must not discard the merged work, which exists nowhere else.
      const second = await world.capshelf(project, [
        "update",
        "skills/hello",
        "--merge",
        "--json",
      ]);
      expectExit(second, 0);
      const secondRow = mergeRow(second.stdout);
      expect(secondRow.merged).toBeUndefined();
      expect(secondRow.mergeBase).toBeUndefined();
      await expectBytes(installed, MERGED);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a merge conflict lists every conflicting path in sorted order and changes nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "when both sides rewrite the same regions, update --merge exits 3, lists the item-relative conflicting paths sorted, and leaves the installed copy, the lock, and the data repo byte-identical",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      // Created out of alphabetical order so a listing that echoes discovery
      // order fails the check.
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "skills/multi/SKILL.md": `${HEAD}base\n`,
          "skills/multi/zeta.md": "base\n",
          "skills/multi/alpha.md": "base\n",
          "skills/multi/middle.md": "base\n",
        },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "skills/multi"]), 0);

      await world.git.writeAndCommit(
        shelf,
        {
          "skills/multi/zeta.md": "upstream\n",
          "skills/multi/alpha.md": "upstream\n",
          "skills/multi/middle.md": "upstream\n",
        },
        "upstream rewrites every file",
      );
      await world.git.writeFiles(project, {
        ".agents/skills/multi/zeta.md": "local\n",
        ".agents/skills/multi/alpha.md": "local\n",
        ".agents/skills/multi/middle.md": "local\n",
      });

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["skills"] },
        });
      const before = await snapshot();

      const refused = await world.capshelf(project, [
        "update",
        "skills/multi",
        "--merge",
      ]);
      expectExit(refused, 3);
      expectOutputContains(
        refused,
        "automatic merge conflicts in skills/multi",
      );
      expectOutputContains(refused, "nothing changed");

      const listed = `${refused.stdout}${refused.stderr}`
        .split("conflicting paths:")[1]
        ?.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      expect(listed).toEqual(["alpha.md", "middle.md", "zeta.md"]);

      expectSameState(before, await snapshot(), "conflicted merge");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "update --merge refuses the kinds whose content it cannot three-way merge",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "update --merge exits 3 and names the kind for a settings fragment and for a subagent, writing nothing, because a merged output file has no canonical source to promote back",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "settings/sec/settings.json": '{"model":"opus"}\n',
          "subagents/rev/claude.md":
            "---\nname: rev\ndescription: Review.\n---\n\nReview.\n",
        },
      });
      const project = await world.git.createProject("atlas");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "settings/sec"]), 0);
      expectExit(await world.capshelf(project, ["add", "subagents/rev"]), 0);

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["settings", "subagents"] },
        });

      for (const ref of ["settings/sec", "subagents/rev"]) {
        const before = await snapshot();
        const refused = await world.capshelf(project, [
          "update",
          ref,
          "--merge",
        ]);
        expectExit(refused, 3);
        expectOutputContains(
          refused,
          "update --merge supports only skills, plugins, pi-extensions",
        );
        expectOutputContains(refused, `${ref} is not supported`);
        expectSameState(before, await snapshot(), `refused --merge for ${ref}`);
      }
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
