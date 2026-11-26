import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectBytes,
  expectExit,
  expectOutputContains,
  expectSameState,
} from "../support/assertions";
import { runInPty } from "../support/pty";
import { declareEvidence } from "../support/report";
import { asObject, parseJsonText } from "../support/json";
import { E2E_TEST_TIMEOUT_MS, withWorld } from "../support/world";

const SCENARIO = "environment-cells";

const PROJECT_MCP =
  '{"mcpServers":{"internal-db":{"command":"internal-db-mcp"}}}\n';

const PULLED_SKILL = "---\nname: pdf\ndescription: Extract text\n---\n\nbody\n";

/**
 * Pipes refuse a destructive change outright while a terminal asks, so both
 * halves must run or the prompt is only ever proved absent.
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
      const mcp = asObject(
        parseJsonText(
          await Bun.file(join(project, ".mcp.json")).text(),
          ".mcp.json",
        ),
        ".mcp.json",
      );
      expect(
        Object.keys(asObject(mcp.mcpServers, "mcpServers")).sort(),
      ).toEqual(["github", "internal-db"]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);

/**
 * A remote skill authorizes unreviewed content to run with the user's
 * permissions, and every other cell uses `--yes` which never asks, so both
 * answers must be driven on a terminal here.
 */
test(
  "with a terminal, a remote skill states its facts, asks once, and a refusal writes nothing",
  async () => {
    declareEvidence({
      scenario: SCENARIO,
      property:
        "on a TTY, add <url> reports the repository, the file list, and the license finding before it asks; answering no exits 0 and leaves no install and no record, and answering yes installs the skill and says it is not committed",
      labels: ["reproduced-user-workflow", "modeled-external-step"],
      modeledSteps: [
        "the third-party host is a local bare repository reached over file://, standing in for github.com",
      ],
      proofLimits: [
        "the terminal is opened by a helper rather than by a real terminal emulator, so line-discipline details such as echo and CR endings differ from an interactive shell",
        "the repository holds one skill, so the marking picker a multi-skill repository opens is not exercised here",
      ],
    });

    await withWorld(SCENARIO, async (world) => {
      const upstream = await world.git.createBareRemote("third-party");
      const upstreamWork = await world.git.createDataRepo({
        name: "third-party-work",
        origin: upstream.url,
        skills: { pdf: PULLED_SKILL },
      });
      await world.git.ok(upstreamWork, ["push", "-q", "-u", "origin", "main"]);

      const shelf = await world.git.createDataRepo({
        name: "shelf",
        origin: null,
        skills: { placeholder: "---\nname: placeholder\n---\n\nbody\n" },
      });
      const project = await world.git.createProject("app");
      expectExit(
        await world.capshelf(project, [
          "init",
          "--data",
          shelf,
          "--no-upstream",
        ]),
        0,
      );

      const lockPath = join(project, ".capshelf", "remotes.lock.json");
      const snapshot = () =>
        captureOwnedState(world, {
          projectFiles: project,
          projectGit: project,
          requiredAbsent: [lockPath],
        });
      const before = await snapshot();

      const declined = await runInPty(
        world,
        project,
        [world.binary, "add", upstream.url],
        { answer: "n\n" },
      );
      expectExit(declined, 0);
      expectOutputContains(declined, upstream.url);
      expectOutputContains(declined, "SKILL.md");
      expectOutputContains(
        declined,
        "none found in the item or at the repo root",
      );
      expectOutputContains(declined, "does not review this content");
      expectOutputContains(declined, "Install it? [y/N]");
      expectOutputContains(declined, "nothing was installed");
      expectSameState(before, await snapshot(), "a declined remote skill");

      const accepted = await runInPty(
        world,
        project,
        [world.binary, "add", upstream.url],
        { answer: "y\n" },
      );
      expectExit(accepted, 0);
      expectOutputContains(accepted, "added local/remote/skills/pdf");
      expectOutputContains(
        accepted,
        "not committed, so your teammates do not get it",
      );
      expectOutputContains(accepted, "share skills/pdf --adopt");
      await expectBytes(
        join(project, ".agents/skills/pdf/SKILL.md"),
        PULLED_SKILL,
      );
      const lock = asObject(
        parseJsonText(await readFile(lockPath, "utf-8"), lockPath),
        lockPath,
      );
      expect(Object.keys(asObject(lock.items, `${lockPath} items`))).toEqual([
        "remote/skills/pdf",
      ]);
    });
  },
  E2E_TEST_TIMEOUT_MS,
);
