import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  addSkill,
  commitAll,
  jsonOutput,
  objectItems,
  runInProcess,
  tempDir,
  tempRepo,
} from "./cli-fixtures";
import { claudeProjectDirName } from "../src/skill-invocations";

describe("status skill invocations", () => {
  test(
    "adds invocation facts only when Claude Code has transcripts for the project",
    async () => {
      const project = await tempRepo("capshelf-invoke-project-");
      const dataRepo = await tempRepo("capshelf-invoke-data-");
      await addSkill(dataRepo, "review");
      await addSkill(dataRepo, "idle");
      await commitAll(dataRepo, "add skills");
      const home = await tempDir("capshelf-invoke-home-");
      const env = {
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        XDG_CACHE_HOME: join(home, "cache"),
      };
      const run = runInProcess(project);
      expect((await run(["init", "--data", dataRepo])).exitCode).toBe(0);
      expect((await run(["add", "skills/review"])).exitCode).toBe(0);
      expect((await run(["add", "skills/idle"])).exitCode).toBe(0);

      const before = await run(["status", "--json"], env);
      const beforeHuman = await run(["status"], env);
      for (const item of objectItems(jsonOutput(before), "items")) {
        expect(item).not.toHaveProperty("invocations");
      }
      expect(beforeHuman.stdout.toString()).not.toContain("invoked");

      const dir = join(
        home,
        "claude",
        "projects",
        claudeProjectDirName(project),
      );
      await mkdir(dir, { recursive: true });
      const lines = [
        {
          type: "user",
          timestamp: "2026-11-01T08:00:00.000Z",
          cwd: project,
          message: { role: "user", content: "hello" },
        },
        {
          type: "assistant",
          timestamp: "2026-11-02T08:00:00.000Z",
          cwd: project,
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Skill",
                input: { skill: "review" },
              },
            ],
          },
        },
      ];
      await writeFile(
        join(dir, "session.jsonl"),
        lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
      );

      const after = await run(["status", "--json"], env);
      const items = objectItems(jsonOutput(after), "items");
      const byName = new Map(items.map((item) => [item.name, item]));
      expect(byName.get("review")?.invocations).toEqual({
        count: 1,
        byAgent: 1,
        byUser: 0,
        last: "2026-11-02T08:00:00.000Z",
        since: "2026-11-01T08:00:00.000Z",
      });
      expect(byName.get("idle")?.invocations).toEqual({
        count: 0,
        byAgent: 0,
        byUser: 0,
        last: null,
        since: "2026-11-01T08:00:00.000Z",
      });

      const human = (await run(["status"], env)).stdout.toString();
      expect(human).toContain(
        "invoked 1 time since 2026-11-01, last 2026-11-02 (agent 1, user 0)",
      );
      expect(human).toContain("not invoked since 2026-11-01");
      // Usage is information, not drift.
      expect((await run(["status", "--strict"], env)).exitCode).toBe(0);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
