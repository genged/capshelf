import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectExit,
  expectSameState,
  parseApplyRows,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "fragment-ownership";

const PROJECT_SETTINGS = JSON.stringify(
  {
    projectOnlyKey: "kept",
    permissions: { deny: ["Bash(rm -rf /)"] },
  },
  null,
  2,
);

const PROJECT_MCP = JSON.stringify(
  {
    mcpServers: {
      "internal-db": { command: "internal-db-mcp" },
    },
  },
  null,
  2,
);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
}

test(
  "a managed fragment owns its own values and leaves the rest of the file alone",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "installing, updating, and removing a fragment preserves every value the project owns in the same output file",
      labels: ["reproduced-user-workflow"],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "settings/base/settings.json": `${JSON.stringify(
            { permissions: { allow: ["Bash(git status)"] } },
            null,
            2,
          )}\n`,
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
        },
      });
      const project = await world.git.createProject("platform");
      await mkdir(join(project, ".claude"), { recursive: true });
      await writeFile(
        join(project, ".claude", "settings.json"),
        `${PROJECT_SETTINGS}\n`,
      );
      await writeFile(join(project, ".mcp.json"), `${PROJECT_MCP}\n`);

      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "settings/base"]), 0);
      expectExit(await world.capshelf(project, ["add", "mcp/github"]), 0);

      const settings = await readJson(
        join(project, ".claude", "settings.json"),
      );
      expect(settings.projectOnlyKey).toBe("kept");
      expect(settings.permissions).toEqual({
        deny: ["Bash(rm -rf /)"],
        allow: ["Bash(git status)"],
      });

      const mcp = await readJson(join(project, ".mcp.json"));
      expect(Object.keys(mcp.mcpServers as object).sort()).toEqual([
        "github",
        "internal-db",
      ]);

      // Upstream moves; the project's own values still do not.
      await world.git.writeAndCommit(
        shelf,
        {
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp-v2"}}}\n',
        },
        "github mcp v2",
      );
      expectExit(await world.capshelf(project, ["update", "mcp/github"]), 0);
      const updated = await readJson(join(project, ".mcp.json"));
      expect(
        (updated.mcpServers as Record<string, { command: string }>).github
          ?.command,
      ).toBe("github-mcp-v2");
      expect(
        (updated.mcpServers as Record<string, { command: string }>)[
          "internal-db"
        ]?.command,
      ).toBe("internal-db-mcp");

      // Null second run: reconciling again changes nothing.
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

      // Removal reconciles the managed contribution and nothing else.
      expectExit(
        await world.capshelf(project, ["rm", "mcp/github", "--yes"]),
        0,
      );
      const afterRemoval = await readJson(join(project, ".mcp.json"));
      expect(Object.keys(afterRemoval.mcpServers as object)).toEqual([
        "internal-db",
      ]);
      const settingsAfter = await readJson(
        join(project, ".claude", "settings.json"),
      );
      expect(settingsAfter.projectOnlyKey).toBe("kept");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "one unwritable fragment target rolls back every other fragment write",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "when a later fragment output cannot be swapped, the earlier swap is rolled back and no lock change is persisted",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the write failure is produced with directory permissions; a full disk, a read-only mount, and a hostile filter driver are other producers this does not exercise",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
          "mcp/github/codex.toml":
            '[mcp_servers.github]\ncommand = "github-mcp"\n',
        },
      });
      const project = await world.git.createProject("platform");
      await writeFile(join(project, ".mcp.json"), `${PROJECT_MCP}\n`);
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "mcp/github"]), 0);

      // Both outputs must have real work to do, or the target that is meant
      // to fail is skipped as already-current and the test proves nothing.
      await world.git.writeAndCommit(
        shelf,
        {
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp-v2"}}}\n',
          "mcp/github/codex.toml":
            '[mcp_servers.github]\ncommand = "github-mcp-v2"\n',
        },
        "github mcp v2",
      );

      const codexDir = join(project, ".codex");
      await chmod(codexDir, 0o500);
      try {
        const probe = await world.run(project, [
          "/bin/sh",
          "-c",
          `: > "${join(codexDir, "probe.tmp")}"`,
        ]);
        if (probe.outcome.kind === "exit" && probe.outcome.exitCode === 0) {
          throw new Error(
            "this cell needs an effective user that cannot write a mode-500 directory; " +
              "the create probe succeeded, so the run is probably root and the refusal it asserts cannot happen",
          );
        }

        const before = await captureOwnedState(world, {
          projectFiles: {
            path: project,
            include: [".capshelf", ".mcp.json", ".codex"],
          },
        });
        const failed = await world.capshelf(project, [
          "update",
          "mcp/github",
          "--yes",
          "--json",
        ]);
        expectExit(failed, 1);
        const rows = JSON.parse(failed.stdout) as {
          items: { key: string; action: string; error?: string }[];
        };
        const errored = rows.items.filter((row) => row.action === "error");
        expect(errored.length).toBe(1);
        expect(errored[0]?.error ?? "").toContain(".codex/config.toml");
        expectSameState(
          before,
          await captureOwnedState(world, {
            projectFiles: {
              path: project,
              include: [".capshelf", ".mcp.json", ".codex"],
            },
          }),
          "update with an unwritable fragment target",
        );
      } finally {
        await chmod(codexDir, 0o755);
      }

      // With the target writable again the same command converges, and the
      // project's own value is still there.
      expectExit(
        await world.capshelf(project, ["update", "mcp/github", "--yes"]),
        0,
      );
      const mcp = await readJson(join(project, ".mcp.json"));
      expect(
        (mcp.mcpServers as Record<string, { command: string }>).github?.command,
      ).toBe("github-mcp-v2");
      expect(
        (mcp.mcpServers as Record<string, { command: string }>)["internal-db"]
          ?.command,
      ).toBe("internal-db-mcp");
      expect(
        await Bun.file(join(project, ".codex", "config.toml")).text(),
      ).toContain("github-mcp-v2");
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

test(
  "apply rolls back an earlier fragment write when a later target fails",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "apply preflights every fragment target before writing any of them, so a target that cannot be swapped leaves the other outputs byte-identical",
      labels: ["reproduced-user-workflow"],
      proofLimits: [
        "the write failure is produced with directory permissions; a full disk, a read-only mount, and a hostile filter driver are other producers this does not exercise",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const shelf = await world.git.createDataRepo({
        origin: "https://example.invalid/shelf.git",
        files: {
          "mcp/github/claude.json":
            '{"mcpServers":{"github":{"command":"github-mcp"}}}\n',
          "mcp/github/codex.toml":
            '[mcp_servers.github]\ncommand = "github-mcp"\n',
        },
      });
      const project = await world.git.createProject("platform");
      await writeFile(join(project, ".mcp.json"), `${PROJECT_MCP}\n`);
      expectExit(await world.capshelf(project, ["init", "--data", shelf]), 0);
      expectExit(await world.capshelf(project, ["add", "mcp/github"]), 0);

      // Both managed contributions are removed by hand, so apply has real
      // work to do in each output. Without that the failing target is skipped
      // as already-current and the test proves nothing.
      await writeFile(join(project, ".mcp.json"), `${PROJECT_MCP}\n`);
      await writeFile(
        join(project, ".codex", "config.toml"),
        'model = "gpt-5"\n',
      );

      const codexDir = join(project, ".codex");
      await chmod(codexDir, 0o500);
      try {
        const probe = await world.run(project, [
          "/bin/sh",
          "-c",
          `: > "${join(codexDir, "probe.tmp")}"`,
        ]);
        if (probe.outcome.kind === "exit" && probe.outcome.exitCode === 0) {
          throw new Error(
            "this cell needs an effective user that cannot write a mode-500 directory; " +
              "the create probe succeeded, so the run is probably root and the refusal it asserts cannot happen",
          );
        }

        const before = await captureOwnedState(world, {
          projectFiles: {
            path: project,
            include: [".capshelf", ".mcp.json", ".codex"],
          },
        });
        // "Commands that reconcile multiple fragment outputs preflight every
        // target before writing any of them. If a later output swap fails,
        // earlier swaps are rolled back" (docs/cli.md:449-457). A partial
        // write leaves one runtime disagreeing with the lock, which is the
        // failure the rule exists to prevent.
        const failed = await world.capshelf(project, [
          "apply",
          "--yes",
          "--json",
        ]);
        expectExit(failed, 1);
        expectSameState(
          before,
          await captureOwnedState(world, {
            projectFiles: {
              path: project,
              include: [".capshelf", ".mcp.json", ".codex"],
            },
          }),
          "apply with an unwritable fragment target",
        );
      } finally {
        await chmod(codexDir, 0o755);
      }

      // With the target writable again the same command converges.
      expectExit(await world.capshelf(project, ["apply", "--yes"]), 0);
      const mcp = await readJson(join(project, ".mcp.json"));
      expect(Object.keys(mcp.mcpServers as object).sort()).toEqual([
        "github",
        "internal-db",
      ]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
