import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectOutputContains,
  expectSameState,
} from "../support/assertions";
import { runInPty } from "../support/pty";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "environment-cells";

const PROJECT_MCP =
  '{"mcpServers":{"internal-db":{"command":"internal-db-mcp"}}}\n';

/**
 * The terminal dimension. Every other cell runs through pipes, where a
 * destructive change is refused outright; with a controlling terminal the same
 * state asks, and the answer decides. Both halves have to be exercised, or the
 * prompt is only ever proved to be absent.
 */
test(
  "with a terminal, a destructive change asks first and a refusal writes nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "on a TTY, apply prompts before replacing a managed contribution; answering no exits 0 and writes nothing, and answering yes converges",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR endings differ from an interactive shell",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
        },
      });
      const project = await world.git.createProject("platform");
      await writeFile(join(project, ".mcp.json"), PROJECT_MCP);
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "mcp/github"]), 0);

      // Remove the managed contribution by hand: reconciling it back is a
      // destructive change to local state.
      await writeFile(join(project, ".mcp.json"), PROJECT_MCP);

      const before = await captureOwnedState(world, {
        projectFiles: { path: project, include: [".capshelf", ".mcp.json"] },
      });
      const declined = await runInPty(world, project, [world.binary, "apply"], {
        answer: "n\n",
      });
      expectExit(declined, 0);
      expectOutputContains(declined, "Continue? [y/N]");
      expectOutputContains(declined, "no changes were written");
      expectSameState(
        before,
        await captureOwnedState(world, {
          projectFiles: { path: project, include: [".capshelf", ".mcp.json"] },
        }),
        "declined consent prompt",
      );

      const accepted = await runInPty(world, project, [world.binary, "apply"], {
        answer: "y\n",
      });
      expectExit(accepted, 0);
      const mcp = JSON.parse(
        await Bun.file(join(project, ".mcp.json")).text(),
      ) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(mcp.mcpServers).sort()).toEqual([
        "github",
        "internal-db",
      ]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
