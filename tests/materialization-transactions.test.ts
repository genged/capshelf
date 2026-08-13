import { file } from "bun";
import { describe, expect, test } from "bun:test";
import { currentPinDigest } from "./pin-fixtures";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyFragmentOutputPlans,
  type FragmentOutputPlan,
} from "../src/fragments";
import { lastTouchingContentCommit } from "../src/git";
import { materializeLockEntry } from "../src/materialize";
import { dataKey } from "../src/lock";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  baselineRepo,
  commitAll,
  runIn,
  tempDir,
  tempRepo,
} from "./cli-fixtures";

function fragmentPlan(
  path: string,
  currentText: string | null,
  plannedText: string | null,
): FragmentOutputPlan {
  return {
    target: "claude-settings",
    path,
    currentText,
    plannedText,
    currentSha: null,
    plannedSha: null,
    changed: currentText !== plannedText,
    commentLoss: false,
    commentPolicy: "repair",
  };
}

describe("materialization transactions", () => {
  test("fragment batches preflight every output and roll back later failures", async () => {
    const root = await tempDir("capshelf-fragment-batch-");
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    await writeFile(first, "old first\n");
    await writeFile(second, "actual second\n");

    await expect(
      applyFragmentOutputPlans([
        fragmentPlan(first, "old first\n", "new first\n"),
        fragmentPlan(second, "stale second\n", "new second\n"),
      ]),
    ).rejects.toThrow(/changed after preflight/u);
    expect(await file(first).text()).toBe("old first\n");
    expect(await file(second).text()).toBe("actual second\n");

    await writeFile(second, "old second\n");
    await expect(
      applyFragmentOutputPlans(
        [
          fragmentPlan(first, "old first\n", "new first\n"),
          fragmentPlan(second, "old second\n", "new second\n"),
        ],
        {
          beforeWrite: async (_plan, index) => {
            if (index === 1) throw new Error("injected swap failure");
          },
        },
      ),
    ).rejects.toThrow("injected swap failure");
    expect(await file(first).text()).toBe("old first\n");
    expect(await file(second).text()).toBe("old second\n");
  });

  test(
    "multi-target update writes no outputs or metadata when a later target collides",
    async () => {
      const dataRepo = await baselineRepo("capshelf-fragment-update-data-");
      const settingsSource = join(
        dataRepo,
        "settings",
        "theme",
        "settings.json",
      );
      const mcpSource = join(dataRepo, "mcp", "tool", "claude.json");
      await mkdir(dirname(settingsSource), { recursive: true });
      await mkdir(dirname(mcpSource), { recursive: true });
      await writeFile(settingsSource, JSON.stringify({ theme: "dark" }));
      await writeFile(
        mcpSource,
        JSON.stringify({ mcpServers: { tool: { command: "old-tool" } } }),
      );
      await commitAll(dataRepo, "initial fragments");
      const project = await tempRepo("capshelf-fragment-update-project-", {
        origin: null,
      });
      const run = runIn(project);
      expect(run(["init", "--data", dataRepo, "--no-upstream"]).exitCode).toBe(
        0,
      );
      expect(run(["add", "settings/theme"]).exitCode).toBe(0);
      expect(run(["add", "mcp/tool"]).exitCode).toBe(0);
      const settingsOutput = join(project, ".claude", "settings.json");
      const mcpOutput = join(project, ".mcp.json");
      const mcp = await file(mcpOutput).json();
      mcp.mcpServers.unmanaged = { command: "local-command" };
      await writeFile(mcpOutput, `${JSON.stringify(mcp, null, 2)}\n`);

      await writeFile(
        settingsSource,
        JSON.stringify({ theme: "light", introduced: true }),
      );
      await writeFile(
        mcpSource,
        JSON.stringify({
          mcpServers: {
            tool: { command: "new-tool" },
            unmanaged: { command: "upstream-command" },
          },
        }),
      );
      await commitAll(dataRepo, "updated fragments");
      const guardedPaths = [
        settingsOutput,
        mcpOutput,
        join(project, ".capshelf", "capshelf.json"),
        join(project, ".capshelf", "capshelf.lock.json"),
      ];
      const before = await Promise.all(
        guardedPaths.map((path) => readFile(path)),
      );

      const result = run(["update"]);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "overwrite unmanaged local value",
      );
      expect(
        await Promise.all(guardedPaths.map((path) => readFile(path))),
      ).toEqual(before);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test("copy-item materialization stages complete trees and preserves the old install on failures", async () => {
    const dataRepo = await baselineRepo("capshelf-stage-data-");
    const skill = await addSkill(dataRepo, "atomic", "new entrypoint\n");
    await writeFile(join(skill, "guide.md"), "new guide\n");
    await commitAll(dataRepo, "atomic skill");
    const sourceCommit = await lastTouchingContentCommit(
      dataRepo,
      "skills/atomic",
    );
    const sha = await currentPinDigest(dataRepo, "skills", "atomic");

    for (const failure of ["read", "write", "chmod"] as const) {
      const project = await tempDir(`capshelf-stage-${failure}-`);
      const installed = join(project, ".agents", "skills", "atomic");
      await mkdir(installed, { recursive: true });
      await writeFile(join(installed, "SKILL.md"), "old entrypoint\n");
      await writeFile(join(installed, "old.txt"), "old extra\n");
      const entry = {
        source: "data" as const,
        sourcePinDigest: sha,
        sourceCommit,
        appliedAt: "2026-08-03T00:00:00.000Z",
      };
      const lockBefore = structuredClone(entry);
      const failAtOne = async (_path: string, index: number) => {
        if (index === 1) throw new Error(`injected ${failure} failure`);
      };

      await expect(
        materializeLockEntry({
          project,
          dataRepo,
          key: dataKey("skills", "atomic"),
          entry,
          scope: "project",
          hooks:
            failure === "read"
              ? { beforeSourceRead: failAtOne }
              : failure === "write"
                ? { beforeStagedWrite: failAtOne }
                : { beforeStagedChmod: failAtOne },
        }),
      ).rejects.toThrow(`injected ${failure} failure`);
      expect(await file(join(installed, "SKILL.md")).text()).toBe(
        "old entrypoint\n",
      );
      expect(await file(join(installed, "old.txt")).text()).toBe("old extra\n");
      expect(entry).toEqual(lockBefore);
      expect(
        (await readdir(dirname(installed))).filter((name) =>
          name.startsWith(".capshelf-materialize-"),
        ),
      ).toEqual([]);
    }
  });
});
