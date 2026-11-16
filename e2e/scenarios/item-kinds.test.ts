import { expect, test } from "bun:test";
import { join } from "node:path";
import type { OwnedState } from "../support/assertions";
import {
  captureOwnedState,
  expectAbsent,
  expectBytes,
  expectExit,
  expectOutputContains,
  expectSameState,
  parseApplyRows,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

/**
 * No other scenario drives `codex-config` or `subagents` directly (Codex is
 * otherwise reached via mcp or settings), so a fault in their own paths would
 * ship unnoticed.
 */
const SCENARIO = "item-kinds";

test(
  "a codex-config fragment owns its own keys in .codex/config.toml and no others",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "add merges a codex-config fragment into an existing .codex/config.toml, update moves only the managed keys, rm removes only them, and keep-local is refused with exit 3 without writing",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "no Codex runtime is started, so this proves the file capshelf writes, not that Codex loads it",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "codex/config/defaults/config.toml":
            'model = "gpt-5"\nsandbox = "workspace-write"\n',
        },
      });
      const project = await world.git.createProject("api");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);

      const output = join(project, ".codex", "config.toml");
      await world.git.writeFiles(project, {
        ".codex/config.toml": 'profile = "local"\n',
      });

      expectExit(
        await world.capshelf(project, ["add", "codex-config/defaults"]),
        0,
      );
      const merged = await Bun.file(output).text();
      expect(merged).toContain('model = "gpt-5"');
      expect(merged).toContain('sandbox = "workspace-write"');
      expect(merged).toContain('profile = "local"');

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["codex"] },
        });
      const beforeRefusal = await snapshot();
      const refused = await world.capshelf(project, [
        "keep-local",
        "codex-config/defaults",
      ]);
      expectExit(refused, 3);
      expectOutputContains(
        refused,
        "keep-local is not supported for codex-config fragments",
      );
      expectSameState(beforeRefusal, await snapshot(), "refused keep-local");

      await world.git.writeAndCommit(
        shelf,
        {
          "codex/config/defaults/config.toml":
            'model = "gpt-5.1"\nsandbox = "danger-full-access"\n',
        },
        "codex defaults v2",
      );
      expectExit(
        await world.capshelf(project, ["update", "codex-config/defaults"]),
        0,
      );
      const updated = await Bun.file(output).text();
      expect(updated).toContain('model = "gpt-5.1"');
      expect(updated).toContain('sandbox = "danger-full-access"');
      expect(updated).toContain('profile = "local"');
      expect(updated).not.toContain('model = "gpt-5"');

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

      // Exact bytes, because `toContain` would pass with a managed key left
      // behind.
      expectExit(
        await world.capshelf(project, ["rm", "codex-config/defaults"]),
        0,
      );
      await expectBytes(output, 'profile = "local"\n');
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "a subagents item projects one shelf source pair onto both runtime agent files",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "add writes both the Claude and Codex agent files from one subagents item, update follows a runtime target the shelf drops, and keep-local is refused with exit 3 without writing",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "no Claude or Codex runtime is started, so this proves the agent files capshelf writes, not that either runtime loads them",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const claudeSource =
        "---\nname: reviewer\ndescription: Review changes carefully.\n---\n\nReview for correctness.\n";
      const codexSource =
        'name = "reviewer"\ndescription = "Review changes carefully."\ndeveloper_instructions = "Review for correctness."\n';
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "subagents/reviewer/claude.md": claudeSource,
          "subagents/reviewer/codex.toml": codexSource,
        },
      });
      const project = await world.git.createProject("api");
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(
        await world.capshelf(project, ["add", "subagents/reviewer"]),
        0,
      );

      const claudeAgent = join(project, ".claude", "agents", "reviewer.md");
      const codexAgent = join(project, ".codex", "agents", "reviewer.toml");
      await expectBytes(claudeAgent, claudeSource);
      await expectBytes(codexAgent, codexSource);
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);

      const snapshot = (): Promise<OwnedState> =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          dataRepo: { path: shelf, paths: ["subagents"] },
        });
      const beforeRefusal = await snapshot();
      const refused = await world.capshelf(project, [
        "keep-local",
        "subagents/reviewer",
      ]);
      expectExit(refused, 3);
      expectOutputContains(
        refused,
        "keep-local is not supported for subagents/reviewer",
      );
      expectSameState(beforeRefusal, await snapshot(), "refused keep-local");

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

      await world.git.ok(shelf, ["rm", "-q", "subagents/reviewer/codex.toml"]);
      await world.git.commit(shelf, "make reviewer Claude only");
      expectExit(
        await world.capshelf(project, ["update", "subagents/reviewer"]),
        0,
      );
      await expectAbsent(codexAgent);
      await expectBytes(claudeAgent, claudeSource);
      expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
