/**
 * A plugin on the shelf (`plugins/<n>` in the data repo): `add`, `move`,
 * `update`, `promote`, and `status` (spec D3, D7 points 1 to 3, D11, M2).
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectField,
  objectItems,
  readJsonObject,
  runInProcess,
  stringField,
  tempRepo,
} from "./cli-fixtures";
import type { CliResult } from "./cli-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { PLUGIN_FENCE } from "../src/manifest-fence";

const SETUP_HOOK = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
    ],
  },
};

const TWO_HOOKS = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
    ],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "bash hooks/format.sh" }],
      },
    ],
  },
};

async function writeUnder(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const target = join(root, ...relPath.split("/"));
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

/** One shelf plugin: a manifest, a skill, and the extra files given. */
async function writeShelfPlugin(
  dataRepo: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const root = join(dataRepo, "plugins", name);
  await writeUnder(
    root,
    ".claude-plugin/plugin.json",
    JSON.stringify({ name, version: "1.0.0" }),
  );
  await writeUnder(
    root,
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: d\n---\nbody\n`,
  );
  for (const [relPath, content] of Object.entries(files)) {
    await writeUnder(root, relPath, content);
  }
}

interface ShelfWorld {
  project: string;
  dataRepo: string;
  run: (args: string[]) => Promise<CliResult>;
}

/**
 * A data repo with `plugins/gh-cli` (one hook), `plugins/quiet` (no hooks),
 * and `plugins/broken` (an unparseable `hooks/hooks.json`), committed, and a
 * project bound to it with `init --data <repo> --no-upstream`.
 */
async function shelfWorld(): Promise<ShelfWorld> {
  const project = await tempRepo("capshelf-plugins-shelf-project-");
  const dataRepo = await tempRepo("capshelf-plugins-shelf-data-");
  await writeShelfPlugin(dataRepo, "gh-cli", {
    "hooks/hooks.json": JSON.stringify(SETUP_HOOK),
    "hooks/setup.sh": "echo hi\n",
  });
  await writeShelfPlugin(dataRepo, "quiet", {});
  await writeShelfPlugin(dataRepo, "broken", {
    "hooks/hooks.json": "{ not json",
  });
  await commitAll(dataRepo, "baseline");
  const run = runInProcess(project);
  const init = await run(["init", "--data", dataRepo, "--no-upstream"]);
  expect(init.exitCode).toBe(0);
  return { project, dataRepo, run };
}

/** Run with a terminal that answers each prompt from `answers`. */
async function runWithTerminal(
  world: ShelfWorld,
  args: string[],
  answers: string[],
): Promise<{ result: CliResult; prompts: string[] }> {
  const prompts: string[] = [];
  const outer = setDestructiveConfirmationContext({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (message) => {
      prompts.push(message);
      const next = answers.shift();
      if (next === undefined) throw new Error("no answer queued");
      return next;
    },
    stderr: { write: () => {} },
  });
  try {
    return { result: await world.run(args), prompts };
  } finally {
    setDestructiveConfirmationContext(outer);
  }
}

function manifestPath(project: string): string {
  return join(project, ".capshelf", "capshelf.json");
}

function localConfigPath(project: string): string {
  return join(project, ".capshelf", "local.json");
}

function pluginFolder(project: string, name: string): string {
  return join(project, ".agents", "skills", name);
}

async function lockKeys(project: string): Promise<string[]> {
  const lock = await readJsonObject(
    join(project, ".capshelf", "capshelf.lock.json"),
  );
  return Object.keys(objectField(lock, "items")).sort();
}

describe("shelf add plugins/<n> (D7 points 1 and 3)", () => {
  test(
    "a plugin that runs nothing installs with no prompt",
    async () => {
      const world = await shelfWorld();
      const r = await world.run(["add", "plugins/quiet"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(
        "✓ added project/data/plugins/quiet @ ",
      );
      expect(r.stderr.toString()).not.toContain("consent");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "with hooks and no terminal it refuses, names the hooks, and the teammate rule",
    async () => {
      const world = await shelfWorld();
      const manifestBefore = await readFile(manifestPath(world.project));
      const r = await world.run(["add", "plugins/gh-cli"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain(
        "not installing plugins/gh-cli without consent — it runs 1 hook in every Claude Code session in this project",
      );
      expect(err).toContain("bash hooks/setup.sh");
      // Point 3 in the same refusal: project scope is the default.
      expect(err).toContain("every teammate's");
      expect(err).toContain(
        "Claude Code session after they trust this workspace",
      );
      expect(err).toContain("--yes");
      expect(err).toContain("capshelf show plugins/gh-cli");
      // Refused before any write.
      expect(existsSync(pluginFolder(world.project, "gh-cli"))).toBe(false);
      expect(await readFile(manifestPath(world.project))).toEqual(
        manifestBefore,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--json refuses with the spec's error shape",
    async () => {
      const world = await shelfWorld();
      const r = await world.run(["add", "plugins/gh-cli", "--json"]);
      expect(r.exitCode).toBe(3);
      const error = objectField(JSON.parse(r.stderr.toString()), "error");
      expect(stringField(error, "message")).toBe(
        "not installing plugins/gh-cli without consent — it runs 1 hook in every Claude Code session in this project",
      );
      const hint = stringField(error, "hint");
      expect(hint).toContain("review it first, then authorize with --yes");
      expect(hint).toContain("See what it runs: capshelf show plugins/gh-cli");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--yes installs it with the fence and a data/plugins lock key",
    async () => {
      const world = await shelfWorld();
      const r = await world.run(["add", "plugins/gh-cli", "--yes"]);
      expect(r.exitCode).toBe(0);
      // `--yes` skips the question, so what it runs goes to stderr.
      expect(r.stderr.toString()).toContain("bash hooks/setup.sh");
      const manifest = await readJsonObject(manifestPath(world.project));
      expect(manifest.plugins).toEqual(["gh-cli"]);
      expect(manifest.shelves).toBe(PLUGIN_FENCE);
      expect(await lockKeys(world.project)).toContain("data/plugins/gh-cli");
      expect(
        existsSync(
          join(
            pluginFolder(world.project, "gh-cli"),
            ".claude-plugin",
            "plugin.json",
          ),
        ),
      ).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "one prompt covers points 1 and 3, and yes installs",
    async () => {
      const world = await shelfWorld();
      const { result, prompts } = await runWithTerminal(
        world,
        ["add", "plugins/gh-cli"],
        ["y"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0] ?? "";
      expect(prompt).toContain("SessionStart");
      expect(prompt).toContain("bash hooks/setup.sh");
      expect(prompt).toContain(
        "project scope commits it. The hooks then run in every teammate's\n  Claude Code session after they trust this workspace.",
      );
      expect(prompt).toEndWith("Install it? [y/N] ");
      expect(await lockKeys(world.project)).toContain("data/plugins/gh-cli");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "no at the prompt installs nothing",
    async () => {
      const world = await shelfWorld();
      const { result } = await runWithTerminal(
        world,
        ["add", "plugins/gh-cli"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(existsSync(pluginFolder(world.project, "gh-cli"))).toBe(false);
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--local asks point 1 only, and --yes writes the local fence",
    async () => {
      const world = await shelfWorld();
      const refused = await world.run(["add", "plugins/gh-cli", "--local"]);
      expect(refused.exitCode).toBe(3);
      const err = refused.stderr.toString();
      expect(err).toContain("not installing plugins/gh-cli without consent");
      expect(err).not.toContain("every teammate's");

      const { prompts } = await runWithTerminal(
        world,
        ["add", "plugins/gh-cli", "--local"],
        ["n"],
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).not.toContain("project scope commits it");

      const r = await world.run(["add", "plugins/gh-cli", "--local", "--yes"]);
      expect(r.exitCode).toBe(0);
      const local = await readJsonObject(localConfigPath(world.project));
      expect(local.plugins).toEqual(["gh-cli"]);
      expect(local.shelves).toBe(PLUGIN_FENCE);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an unreadable hooks/hooks.json and no other runs still asks (D7)",
    async () => {
      const world = await shelfWorld();
      const r = await world.run(["add", "plugins/broken", "--local"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not installing plugins/broken without consent");
      expect(err).toContain("hooks/hooks.json could not be read");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a bundle that holds a plugin with hooks asks too",
    async () => {
      const world = await shelfWorld();
      await writeUnder(
        world.dataRepo,
        "bundles/team.yml",
        "includes:\n  plugins: [gh-cli, quiet]\n",
      );
      await commitAll(world.dataRepo, "bundle");
      const refused = await world.run(["add", "bundles/team"]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        "not installing plugins/gh-cli without consent",
      );
      expect(await lockKeys(world.project)).not.toContain("data/plugins/quiet");
      const r = await world.run(["add", "bundles/team", "--yes"]);
      expect(r.exitCode).toBe(0);
      expect(await lockKeys(world.project)).toContain("data/plugins/gh-cli");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("move plugins/<n> --to project (D7 point 3)", () => {
  test(
    "refuses with no terminal, asks the spec's question, and --yes moves",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/gh-cli", "--local", "--yes"]))
          .exitCode,
      ).toBe(0);

      const refused = await world.run([
        "move",
        "plugins/gh-cli",
        "--to",
        "project",
      ]);
      expect(refused.exitCode).toBe(3);
      const err = refused.stderr.toString();
      expect(err).toContain(
        "not moving plugins/gh-cli to project scope without consent",
      );
      expect(err).toContain("1 hook");
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );

      const { result, prompts } = await runWithTerminal(
        world,
        ["move", "plugins/gh-cli", "--to", "project"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toEqual([
        "  plugins/gh-cli runs 1 hook.\n" +
          "  project scope commits it. The hooks then run in every teammate's\n" +
          "  Claude Code session after they trust this workspace.\n" +
          "Commit it to the project? [y/N] ",
      ]);
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );

      const moved = await world.run([
        "move",
        "plugins/gh-cli",
        "--to",
        "project",
        "--yes",
      ]);
      expect(moved.exitCode).toBe(0);
      expect(await lockKeys(world.project)).toContain("data/plugins/gh-cli");
      const manifest = await readJsonObject(manifestPath(world.project));
      expect(manifest.shelves).toBe(PLUGIN_FENCE);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--to local asks nothing",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/gh-cli", "--yes"])).exitCode,
      ).toBe(0);
      const r = await world.run(["move", "plugins/gh-cli", "--to", "local"]);
      expect(r.exitCode).toBe(0);
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("shelf update plugins/<n> (D3, D7 point 2)", () => {
  async function installedWorld(): Promise<ShelfWorld> {
    const world = await shelfWorld();
    expect((await world.run(["add", "plugins/gh-cli", "--yes"])).exitCode).toBe(
      0,
    );
    return world;
  }

  test(
    "a commit that adds a hook asks, and --yes moves the pin",
    async () => {
      const world = await installedWorld();
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/hooks.json",
        JSON.stringify(TWO_HOOKS),
      );
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/format.sh",
        "echo f\n",
      );
      await commitAll(world.dataRepo, "add a hook");

      const refused = await world.run(["update", "plugins/gh-cli"]);
      expect(refused.exitCode).toBe(3);
      const err = refused.stderr.toString();
      expect(err).toContain("not updating plugins/gh-cli without consent");
      expect(err).toContain("bash hooks/format.sh");
      expect(err).not.toContain("hooks/setup.sh");
      expect(
        existsSync(
          join(pluginFolder(world.project, "gh-cli"), "hooks/format.sh"),
        ),
      ).toBe(false);

      const { prompts } = await runWithTerminal(
        world,
        ["update", "plugins/gh-cli"],
        ["n"],
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("+ 1 hook");
      expect(prompts[0]).toEndWith("Move the pin? [y/N] ");

      const r = await world.run(["update", "plugins/gh-cli", "--yes"]);
      expect(r.exitCode).toBe(0);
      expect(
        existsSync(
          join(pluginFolder(world.project, "gh-cli"), "hooks/format.sh"),
        ),
      ).toBe(true);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--dry-run asks nothing and reports what the real run would ask",
    async () => {
      const world = await installedWorld();
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/hooks.json",
        JSON.stringify(TWO_HOOKS),
      );
      await commitAll(world.dataRepo, "add a hook");

      const text = await world.run(["update", "plugins/gh-cli", "--dry-run"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout.toString()).toContain("would ask");
      expect(text.stdout.toString()).toContain("bash hooks/format.sh");

      const json = await world.run([
        "update",
        "plugins/gh-cli",
        "--dry-run",
        "--json",
      ]);
      expect(json.exitCode).toBe(0);
      const [row] = objectItems(jsonOutput(json), "items");
      const newRuns = objectField(row ?? {}, "newRuns");
      expect(objectItems(newRuns, "hooks").map((h) => h.command)).toEqual([
        "bash hooks/format.sh",
      ]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a commit that changes only the hook's script does not ask (D7 limit, M2)",
    async () => {
      const world = await installedWorld();
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/setup.sh",
        "echo changed\n",
      );
      await commitAll(world.dataRepo, "change the script only");

      const r = await world.run(["update", "plugins/gh-cli"]);
      expect(r.exitCode).toBe(0);
      expect(
        await readFile(
          join(pluginFolder(world.project, "gh-cli"), "hooks", "setup.sh"),
          "utf-8",
        ),
      ).toBe("echo changed\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a commit that renames the plugin in plugin.json refuses before any write (D3)",
    async () => {
      const world = await installedWorld();
      const lockBefore = await readFile(
        join(world.project, ".capshelf", "capshelf.lock.json"),
      );
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/.claude-plugin/plugin.json",
        JSON.stringify({ name: "gh-tools" }),
      );
      await commitAll(world.dataRepo, "rename");

      for (const args of [
        ["update", "plugins/gh-cli", "--yes"],
        ["update", "plugins/gh-cli", "--merge"],
      ]) {
        const r = await world.run(args);
        expect(r.exitCode).toBe(3);
        const err = r.stderr.toString();
        expect(err).toContain(
          'plugins/gh-cli: the new tree names the plugin "gh-tools" in .claude-plugin/plugin.json',
        );
        expect(err).toContain("capshelf does not rename an item");
      }
      expect(
        await readFile(join(world.project, ".capshelf", "capshelf.lock.json")),
      ).toEqual(lockBefore);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("promote plugins/<n>", () => {
  test(
    "publishes a local edit, and refuses when plugin.json is gone",
    async () => {
      const world = await shelfWorld();
      expect((await world.run(["add", "plugins/quiet"])).exitCode).toBe(0);
      const folder = pluginFolder(world.project, "quiet");
      await writeFile(
        join(folder, "skills", "quiet", "SKILL.md"),
        "---\nname: quiet\ndescription: d\n---\nedited\n",
      );
      const r = await world.run([
        "promote",
        "plugins/quiet",
        "-m",
        "edit quiet",
      ]);
      expect(r.exitCode).toBe(0);
      const shown =
        await $`git -C ${world.dataRepo} show HEAD:plugins/quiet/skills/quiet/SKILL.md`.text();
      expect(shown).toContain("edited");

      await rm(join(folder, ".claude-plugin", "plugin.json"));
      const refused = await world.run([
        "promote",
        "plugins/quiet",
        "-m",
        "drop manifest",
      ]);
      expect(refused.exitCode).toBe(3);
      expect(refused.stderr.toString()).toContain(
        "required .claude-plugin/plugin.json is missing",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("status of a shelf plugin row (D11)", () => {
  test(
    "carries the runs counts in JSON and text, from the installed tree",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/gh-cli", "--yes"])).exitCode,
      ).toBe(0);
      expect((await world.run(["add", "plugins/quiet"])).exitCode).toBe(0);

      const json = await world.run(["status", "--json"]);
      expect(json.exitCode).toBe(0);
      const rows = objectItems(jsonOutput(json), "items");
      const gh = rows.find((row) => row.name === "gh-cli");
      const quiet = rows.find((row) => row.name === "quiet");
      expect(gh?.runs).toEqual({ hooks: 1, mcpServers: 0, unknown: [] });
      expect(quiet?.runs).toEqual({ hooks: 0, mcpServers: 0, unknown: [] });
      const skill = rows.find((row) => row.kind === "skills");
      expect(skill?.runs).toBeUndefined();

      const text = await world.run(["status"]);
      const ghLine = text.stdout
        .toString()
        .split("\n")
        .find((line) => line.includes("data/plugins/gh-cli"));
      expect(ghLine).toContain("hooks: 1");

      // A drifted row reports what Claude Code loads: the installed tree.
      await writeFile(
        join(pluginFolder(world.project, "gh-cli"), "hooks", "hooks.json"),
        JSON.stringify(TWO_HOOKS),
      );
      const drifted = objectItems(
        jsonOutput(await world.run(["status", "plugins/gh-cli", "--json"])),
        "items",
      );
      expect(drifted[0]?.runs).toEqual({
        hooks: 2,
        mcpServers: 0,
        unknown: [],
      });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "reads the pinned tree when the installed folder is missing",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/gh-cli", "--yes"])).exitCode,
      ).toBe(0);
      await rm(pluginFolder(world.project, "gh-cli"), {
        recursive: true,
        force: true,
      });
      const rows = objectItems(
        jsonOutput(await world.run(["status", "plugins/gh-cli", "--json"])),
        "items",
      );
      expect(rows[0]?.runs).toEqual({ hooks: 1, mcpServers: 0, unknown: [] });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
