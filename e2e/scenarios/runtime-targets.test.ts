import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  captureOwnedState,
  expectAbsent,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseApplyRows,
  parseStatusRows,
  statusRow,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "runtime-targets";

interface Coverage {
  target: string;
  present: boolean | null;
  sourcePath: string;
  outputPath: string;
}

function coverageOf(payload: string): Coverage[] {
  const parsed: unknown = JSON.parse(payload);
  const items = (parsed as { items?: unknown }).items;
  const row = Array.isArray(items) ? items[0] : parsed;
  const coverage = (row as { targetCoverage?: unknown }).targetCoverage;
  if (!Array.isArray(coverage)) {
    throw new Error(`no targetCoverage in ${payload}`);
  }
  return coverage as Coverage[];
}

function presence(
  coverage: readonly Coverage[],
): Record<string, boolean | null> {
  return Object.fromEntries(coverage.map((row) => [row.target, row.present]));
}

test(
  "locked target coverage decides which runtime outputs exist and what the gap line says",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "a two-source mcp item writes and reports both runtime targets, a one-source item states its gap without failing strict, and coverage moves only when the pin moves",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "no Claude or Codex runtime is started, so this proves the files capshelf writes, not that a runtime loads them",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "mcp/deepwiki/claude.json":
            '{"mcpServers":{"deepwiki":{"command":"deepwiki-mcp"}}}\n',
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp","args":["stdio"]}}}\n',
          "mcp/github/codex.toml":
            '[mcp_servers.github]\ncommand = "github-mcp"\nargs = ["stdio"]\n',
        },
      });
      const project = await world.git.createProject("api");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      // A one-source item installs, and says which runtime it does not cover.
      const addedDeepwiki = await world.capshelf(project, [
        "add",
        "mcp/deepwiki",
        "--json",
      ]);
      expectExit(addedDeepwiki, 0);
      expect(presence(coverageOf(addedDeepwiki.stdout))).toEqual({
        claude: true,
        codex: false,
      });
      await expectAbsent(join(project, ".codex", "config.toml"));

      const humanAdd = await world.capshelf(project, ["show", "mcp/deepwiki"]);
      expectOutputContains(humanAdd, "mcp/deepwiki/codex.toml");
      expectOutputContains(humanAdd, "capshelf update mcp/deepwiki");

      // The regression this reporting exists for: a two-source item writes
      // both outputs, so it must name both.
      const addedGithub = await world.capshelf(project, [
        "add",
        "mcp/github",
        "--json",
      ]);
      expectExit(addedGithub, 0);
      expect(presence(coverageOf(addedGithub.stdout))).toEqual({
        claude: true,
        codex: true,
      });
      expect(
        await Bun.file(join(project, ".codex", "config.toml")).text(),
      ).toContain("[mcp_servers.github]");
      expect(await Bun.file(join(project, ".mcp.json")).text()).toContain(
        "deepwiki",
      );

      // A gap is a fact, not a fault.
      const strict = await world.capshelf(project, ["status", "--strict"]);
      expectExit(strict, 0);
      const rows = parseStatusRows(
        (await world.capshelf(project, ["status", "--json"])).stdout,
      );
      expect(
        presence(
          (statusRow(rows, "mcp", "deepwiki").targetCoverage ??
            []) as Coverage[],
        ),
      ).toEqual({ claude: true, codex: false });
      expect(
        presence(
          (statusRow(rows, "mcp", "github").targetCoverage ?? []) as Coverage[],
        ),
      ).toEqual({ claude: true, codex: true });

      // Coverage is read at the locked commit. A new source upstream changes
      // nothing until the project asks for it.
      await world.git.writeAndCommit(
        shelf,
        {
          "mcp/deepwiki/codex.toml":
            '[mcp_servers.deepwiki]\ncommand = "deepwiki-mcp"\n',
        },
        "add a codex source for deepwiki",
      );
      const beforeUpdate = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const stillPinned = parseStatusRows(
        (await world.capshelf(project, ["status", "--json"])).stdout,
      );
      expect(
        presence(
          (statusRow(stillPinned, "mcp", "deepwiki").targetCoverage ??
            []) as Coverage[],
        ),
      ).toEqual({ claude: true, codex: false });
      expectSameState(
        beforeUpdate,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "status after the shelf grew a target",
      );

      expectExit(await world.capshelf(project, ["update", "mcp/deepwiki"]), 0);
      expect(
        await Bun.file(join(project, ".codex", "config.toml")).text(),
      ).toContain("[mcp_servers.deepwiki]");
      const afterUpdate = parseStatusRows(
        (await world.capshelf(project, ["status", "--json"])).stdout,
      );
      expect(
        presence(
          (statusRow(afterUpdate, "mcp", "deepwiki").targetCoverage ??
            []) as Coverage[],
        ),
      ).toEqual({ claude: true, codex: true });

      // Null second run.
      const converged = await captureOwnedState(world, {
        projectFiles: project,
        projectGit: project,
      });
      const second = await world.capshelf(project, ["apply", "--json"]);
      expectExit(second, 0);
      for (const row of parseApplyRows(second.stdout)) {
        expect(row.action).toBe("already-current");
      }
      expectSameState(
        converged,
        await captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
        }),
        "second apply",
      );
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "coverage that cannot be read is reported as unknown, not as absent",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "with the data repo unreachable, a status row reports coverage unknown with null presence instead of claiming a gap",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "mcp/deepwiki/claude.json":
            '{"mcpServers":{"deepwiki":{"command":"deepwiki-mcp"}}}\n',
        },
      });
      const project = await world.git.createProject("api");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "mcp/deepwiki"]), 0);

      // Unbind by pointing the binding at a clone that no longer holds the
      // pinned commit: read-only status degrades instead of refusing.
      const emptyShelf = await world.git.createDataRepo({
        name: "other-shelf",
        origin: "https://example.invalid/shelf.git",
        files: { "README.md": "empty\n" },
      });
      const degraded = await world.capshelf(project, [
        "--data",
        emptyShelf,
        "status",
        "--json",
      ]);
      expectExit(degraded, 0);
      const row = statusRow(
        parseStatusRows(degraded.stdout),
        "mcp",
        "deepwiki",
      );
      expect(row.state).toBe("missing_source_commit");
      expect(row.coverageState).toBe("unknown");
      expect(presence((row.targetCoverage ?? []) as Coverage[])).toEqual({
        claude: null,
        codex: null,
      });
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
