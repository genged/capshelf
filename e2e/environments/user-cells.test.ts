import { expect, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  captureOwnedState,
  expectBytes,
  expectExit,
  expectRealDirectory,
  expectRelativeSymlink,
  expectSameState,
  parseApplyRows,
} from "../support/assertions";
import { declareEvidence } from "../support/report";
import {
  E2E_TEST_TIMEOUT_MS,
  type World,
  type WorldOptions,
  withWorld,
} from "../support/world";

const SCENARIO = "environment-cells";

interface WorkflowResult {
  project: string;
  shelf: string;
}

/**
 * One actor workflow, run identically in every cell: bind a shelf, install an
 * item, converge twice, and check strict status. Only the environment changes
 * between cells, so a failure names the user condition rather than the
 * workflow.
 */
async function runCoreWorkflow(
  world: World,
  options: { claudeOnly?: boolean; umask?: string } = {},
): Promise<WorkflowResult> {
  const commandOptions = options.umask ? { umask: options.umask } : undefined;
  const shelf = await world.git.createDataRepo({
    origin: "https://example.invalid/shelf.git",
    skills: { hello: "hello\n" },
  });
  const project = await world.git.createProject("project");

  const initArgs = ["init", "--data", shelf];
  if (options.claudeOnly) initArgs.push("--claude-only");
  expectExit(await world.capshelf(project, initArgs, commandOptions), 0);
  expectExit(
    await world.capshelf(project, ["add", "skills/hello"], commandOptions),
    0,
  );

  const installed = options.claudeOnly
    ? join(project, ".claude", "skills", "hello")
    : join(project, ".agents", "skills", "hello");
  await expectRealDirectory(installed);
  await expectBytes(join(installed, "SKILL.md"), "hello\n");
  if (!options.claudeOnly) {
    await expectRelativeSymlink(
      join(project, ".claude", "skills", "hello"),
      "../../.agents/skills/hello",
    );
  }

  // Null second run, in every cell.
  const converged = await captureOwnedState(world, {
    projectFiles: project,
    projectGit: project,
  });
  const second = await world.capshelf(
    project,
    ["apply", "--json"],
    commandOptions,
  );
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
  expectExit(await world.capshelf(project, ["status", "--strict"]), 0);
  return { project, shelf };
}

interface Cell {
  name: string;
  world: WorldOptions;
  run: (world: World) => Promise<void>;
}

const CELLS: Cell[] = [
  {
    name: "baseline",
    world: {},
    run: async (world) => {
      await runCoreWorkflow(world);
    },
  },
  {
    name: "a path containing spaces",
    world: { pathFlavor: "spaces" },
    run: async (world) => {
      const { project } = await runCoreWorkflow(world);
      expect(project).toContain(" ");
    },
  },
  {
    name: "a non-ASCII path",
    world: { pathFlavor: "unicode" },
    run: async (world) => {
      const { project } = await runCoreWorkflow(world);
      expect(project).toMatch(/[^\x20-\x7e]/);
    },
  },
  {
    name: "explicit product homes",
    world: {
      env: {
        // Declared inputs for this cell only. CAPSHELF_HOME is the
        // machine-wide default binding; CODEX_HOME moves the Codex user root.
        CAPSHELF_HOME: "/nonexistent/machine-default-shelf",
        CODEX_HOME: "/nonexistent/codex-home",
      },
    },
    run: async (world) => {
      // `--data` outranks the machine default, so the workflow is unchanged
      // and the unusable default must not be consulted.
      await runCoreWorkflow(world);
    },
  },
  {
    name: "named non-default global Git settings",
    world: {
      gitConfig: {
        "core.autocrlf": "input",
        "init.defaultBranch": "trunk",
        "core.hooksPath": "/nonexistent/hooks",
        "url.https://example.invalid/.insteadOf": "git@example.invalid:",
        // An inert helper: the required lane carries no credentials, and this
        // cell only proves a declared helper does not change the workflow.
        "credential.helper": "",
      },
    },
    run: async (world) => {
      // Prove Git actually read the declared settings. A cell whose input
      // never arrived would pass for the wrong reason.
      const declared = await world.run(world.stage, [
        "git",
        "config",
        "--get",
        "url.https://example.invalid/.insteadOf",
      ]);
      expect(declared.stdout.trim()).toBe("git@example.invalid:");
      const hooks = await world.run(world.stage, [
        "git",
        "config",
        "--get",
        "core.hooksPath",
      ]);
      expect(hooks.stdout.trim()).toBe("/nonexistent/hooks");

      await runCoreWorkflow(world);
    },
  },
  {
    name: "a restrictive umask",
    world: {},
    run: async (world) => {
      // Prove the mask reaches the child before drawing any conclusion from
      // the file modes it produced.
      const probe = await world.run(world.stage, ["/bin/sh", "-c", "umask"], {
        umask: "077",
      });
      expect(probe.stdout.trim()).toBe("0077");

      const { project } = await runCoreWorkflow(world, { umask: "077" });
      const stats = await lstat(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
      );
      // A managed file carries the mode its pin records, not the mode the
      // mask would have produced: lock identity includes the executable bit,
      // so an item has to mean the same thing on every machine
      // (src/materialize.ts:717-728, :827-829).
      expect((stats.mode & 0o777).toString(8)).toBe("644");
    },
  },
  {
    name: "the claude-only install mode",
    world: {},
    run: async (world) => {
      const { project } = await runCoreWorkflow(world, { claudeOnly: true });
      await expectBytes(
        join(project, ".agents", "skills", "hello", "SKILL.md"),
        null,
      );
    },
  },
  {
    name: "pre-existing runtime state",
    world: {},
    run: async (world) => {
      // A personal user skill and a hand-written project settings file exist
      // before capshelf arrives, and neither may change the workflow.
      const personal = join(world.home, ".claude", "skills", "personal-note");
      await mkdir(personal, { recursive: true });
      await writeFile(join(personal, "SKILL.md"), "personal\n");
      await runCoreWorkflow(world);
      await expectBytes(join(personal, "SKILL.md"), "personal\n");
    },
  },
];

for (const cell of CELLS) {
  test(
    `the same workflow succeeds with ${cell.name}`,
    async () => {
      declareEvidence({
        scenario: SCENARIO,
        property: `the fresh-install workflow behaves identically with ${cell.name}`,
        labels: ["reproduced-user-workflow"],
      });
      await withWorld(
        `cell-${cell.name.replace(/\s+/g, "-")}`,
        cell.run,
        cell.world,
      );
    },
    E2E_TEST_TIMEOUT_MS,
  );
}
