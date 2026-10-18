/**
 * A plugin on the shelf (`plugins/<n>` in the data repo): `add`, `move`,
 * `update`, `promote`, `status`, and `share --adopt` (spec D3, D7 points 1
 * to 3, D9, D11, M2, M3, M4).
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
import type { PluginSpec } from "./plugin-fixtures";
import {
  initRemoteProject,
  pluginUpstream,
  pushPluginChange,
  upstreamWith,
} from "./remote-fixtures";
import type { RemoteProject, Upstream } from "./remote-fixtures";
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
    "text output names the plugin the way Claude Code loads it, and JSON does not change (D2 guard 4)",
    async () => {
      const world = await shelfWorld();
      const r = await world.run(["add", "plugins/quiet", "--local"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(
        "  Claude Code loads it as quiet@skills-dir in a trusted workspace\n",
      );
      const json = await world.run([
        "add",
        "plugins/gh-cli",
        "--yes",
        "--json",
      ]);
      expect(json.exitCode).toBe(0);
      const payload = jsonOutput(json);
      expect(stringField(payload, "kind")).toBe("plugins");
      expect(json.stdout.toString()).not.toContain("skills-dir");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

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
    "a plugin with only monitors/monitors.json asks, and names the monitors",
    async () => {
      const world = await shelfWorld();
      await writeShelfPlugin(world.dataRepo, "watcher", {
        "monitors/monitors.json": JSON.stringify([
          { name: "w", command: "bash watch.sh", description: "d" },
        ]),
      });
      await commitAll(world.dataRepo, "watcher");
      const r = await world.run(["add", "plugins/watcher"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain(
        "not installing plugins/watcher without consent — capshelf cannot list everything it runs",
      );
      expect(err).toContain(
        "unknown: monitors/monitors.json declares background monitors; capshelf does not list them",
      );
      expect(existsSync(pluginFolder(world.project, "watcher"))).toBe(false);

      expect(
        (await world.run(["add", "plugins/watcher", "--yes"])).exitCode,
      ).toBe(0);
      const rows = objectItems(
        jsonOutput(await world.run(["status", "plugins/watcher", "--json"])),
        "items",
      );
      expect(rows[0]?.runs).toEqual({
        hooks: 0,
        mcpServers: 0,
        unknown: [
          "monitors/monitors.json declares background monitors; capshelf does not list them",
        ],
      });
      const text = await world.run(["status"]);
      const line = text.stdout
        .toString()
        .split("\n")
        .find((row) => row.includes("data/plugins/watcher"));
      expect(line).toContain("runs: unknown");
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

describe("bundle consent pins (D7 point 1)", () => {
  test(
    "a skill member installs the tree read before the prompt, not a newer one",
    async () => {
      const world = await shelfWorld();
      await writeUnder(
        world.dataRepo,
        "skills/plain/SKILL.md",
        "---\nname: plain\ndescription: d\n---\nbody\n",
      );
      await writeUnder(
        world.dataRepo,
        "bundles/pair.yml",
        "includes:\n  skills: [plain]\n  plugins: [gh-cli]\n",
      );
      await commitAll(world.dataRepo, "bundle");

      // While the gh-cli prompt is open, a commit turns plain into a plugin
      // with a hook. The prompt never listed that hook.
      const { result } = await runWithTerminalDuring(
        world,
        ["add", "bundles/pair"],
        async () => {
          await writeUnder(
            world.dataRepo,
            "skills/plain/.claude-plugin/plugin.json",
            JSON.stringify({ name: "plain" }),
          );
          await writeUnder(
            world.dataRepo,
            "skills/plain/hooks/hooks.json",
            JSON.stringify(SETUP_HOOK),
          );
          await commitAll(world.dataRepo, "plain becomes a plugin");
        },
      );
      const plainFolder = pluginFolder(world.project, "plain");
      expect(existsSync(join(plainFolder, "hooks", "hooks.json"))).toBe(false);
      expect(
        existsSync(join(plainFolder, ".claude-plugin", "plugin.json")),
      ).toBe(false);
      if (result.exitCode === 0) {
        expect(existsSync(join(plainFolder, "SKILL.md"))).toBe(true);
      }
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

/** Run with a terminal whose first prompt runs `during`, then answers yes. */
async function runWithTerminalDuring(
  world: ShelfWorld,
  args: string[],
  during: () => Promise<void>,
): Promise<{ result: CliResult; prompts: string[] }> {
  const prompts: string[] = [];
  const outer = setDestructiveConfirmationContext({
    stdinIsTTY: true,
    stderrIsTTY: true,
    prompt: async (message) => {
      prompts.push(message);
      if (prompts.length === 1) await during();
      return "y";
    },
    stderr: { write: () => {} },
  });
  try {
    return { result: await world.run(args), prompts };
  } finally {
    setDestructiveConfirmationContext(outer);
  }
}

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
    "asks for a hook the installed copy holds but the pin does not",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/quiet", "--local"])).exitCode,
      ).toBe(0);
      // `moveScope` compares only pinned paths, so an extra file passes it.
      await writeUnder(
        pluginFolder(world.project, "quiet"),
        "hooks/hooks.json",
        JSON.stringify(SETUP_HOOK),
      );

      const refused = await world.run([
        "move",
        "plugins/quiet",
        "--to",
        "project",
      ]);
      expect(refused.exitCode).toBe(3);
      const err = refused.stderr.toString();
      expect(err).toContain(
        "not moving plugins/quiet to project scope without consent",
      );
      expect(err).toContain("plugins/quiet runs 1 hook.");
      expect(await lockKeys(world.project)).not.toContain("data/plugins/quiet");
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
    "an unreadable hooks/hooks.json in both trees still asks (D7)",
    async () => {
      const world = await shelfWorld();
      expect(
        (await world.run(["add", "plugins/broken", "--yes"])).exitCode,
      ).toBe(0);
      await writeUnder(
        world.dataRepo,
        "plugins/broken/hooks/hooks.json",
        "{ still not json, but different",
      );
      await commitAll(world.dataRepo, "change the unreadable hooks");

      const r = await world.run(["update", "plugins/broken"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not updating plugins/broken without consent");
      expect(err).toContain("hooks/hooks.json could not be read");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--merge refuses a merged tree whose local manifest renames the plugin (D3)",
    async () => {
      const world = await installedWorld();
      const lockPath = join(world.project, ".capshelf", "capshelf.lock.json");
      const lockBefore = await readFile(lockPath, "utf-8");
      await writeUnder(
        pluginFolder(world.project, "gh-cli"),
        ".claude-plugin/plugin.json",
        JSON.stringify({ name: "gh-tools", version: "1.0.0" }),
      );
      await writeUnder(world.dataRepo, "plugins/gh-cli/README.md", "x\n");
      await commitAll(world.dataRepo, "change another file");

      const r = await world.run(["update", "plugins/gh-cli", "--merge"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        'plugins/gh-cli: the new tree names the plugin "gh-tools"',
      );
      expect(await readFile(lockPath, "utf-8")).toBe(lockBefore);
      expect(
        existsSync(join(pluginFolder(world.project, "gh-cli"), "README.md")),
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--merge with no terminal does not tell the user to pass --yes",
    async () => {
      const world = await installedWorld();
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/hooks.json",
        JSON.stringify(TWO_HOOKS),
      );
      await commitAll(world.dataRepo, "add a hook");

      const r = await world.run(["update", "plugins/gh-cli", "--merge"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("not updating plugins/gh-cli without consent");
      expect(err).toContain(
        "review it first. --merge does not take --yes: run it in a terminal to answer the prompt, or take the new tree without your local edits with capshelf update plugins/gh-cli --yes",
      );
      expect(err).not.toContain("then authorize with --yes");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--merge refuses when the data repo moves while the prompt is open",
    async () => {
      const world = await installedWorld();
      const lockPath = join(world.project, ".capshelf", "capshelf.lock.json");
      const lockBefore = await readFile(lockPath);
      await writeUnder(
        world.dataRepo,
        "plugins/gh-cli/hooks/hooks.json",
        JSON.stringify(TWO_HOOKS),
      );
      await commitAll(world.dataRepo, "add a hook");

      const unseen = structuredClone(TWO_HOOKS);
      unseen.hooks.SessionStart.push({
        hooks: [{ type: "command", command: "bash hooks/unseen.sh" }],
      });
      const prompts: string[] = [];
      const outer = setDestructiveConfirmationContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (message) => {
          prompts.push(message);
          // A commit lands after the user saw the prompt and before the
          // merge reads the data repo.
          await writeUnder(
            world.dataRepo,
            "plugins/gh-cli/hooks/hooks.json",
            JSON.stringify(unseen),
          );
          await commitAll(world.dataRepo, "add a hook nobody approved");
          return "y";
        },
        stderr: { write: () => {} },
      });
      let r: CliResult;
      try {
        r = await world.run(["update", "plugins/gh-cli", "--merge"]);
      } finally {
        setDestructiveConfirmationContext(outer);
      }
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("bash hooks/format.sh");
      expect(prompts[0]).not.toContain("unseen");
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        "changed while preparing the merge; nothing was written",
      );
      expect(await readFile(lockPath)).toEqual(lockBefore);
      expect(
        await readFile(
          join(pluginFolder(world.project, "gh-cli"), "hooks", "hooks.json"),
          "utf-8",
        ),
      ).not.toContain("unseen");
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

const REMOTE_GH: PluginSpec = {
  dir: "plugins/gh-cli",
  manifestName: "gh-cli",
  skills: [{ name: "gh-cli", description: "GitHub CLI" }],
  files: {
    "hooks/hooks.json": JSON.stringify(SETUP_HOOK),
    "hooks/setup.sh": "echo hi\n",
  },
};

interface AdoptWorld {
  world: RemoteProject;
  upstream: Upstream;
  run: (args: string[]) => Promise<CliResult>;
}

/**
 * `plugins/gh-cli` installed from an upstream as a remote row (Task 8).
 * `rootLicense` commits a LICENSE at the upstream root, outside the plugin,
 * before the install.
 */
async function remotePluginWorld(
  opts: { rootLicense?: boolean; pluginLicense?: boolean } = {},
): Promise<AdoptWorld> {
  const world = await initRemoteProject();
  const spec: PluginSpec = opts.pluginLicense
    ? {
        ...REMOTE_GH,
        files: { ...REMOTE_GH.files, LICENSE: "MIT License\n" },
      }
    : REMOTE_GH;
  const upstream = await pluginUpstream([spec], {});
  if (opts.rootLicense) {
    await pushPluginChange(upstream, "LICENSE", "MIT License\n\nCopyright\n");
  }
  const inProcess = runInProcess(world.project);
  const run = (args: string[]): Promise<CliResult> =>
    inProcess(args, world.env);
  const added = await run([
    "add",
    upstream.url,
    "--path",
    "plugins/gh-cli",
    "--yes",
  ]);
  expect(added.exitCode).toBe(0);
  return { world, upstream, run };
}

async function headOf(repo: string): Promise<string> {
  return (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
}

function remotesLockPath(project: string): string {
  return join(project, ".capshelf", "remotes.lock.json");
}

describe("share plugins/<n> --adopt (D9, M3, M4)", () => {
  test(
    "copies the edited plugin to the shelf, records provenance, and releases the remote row",
    async () => {
      const { world, run } = await remotePluginWorld();
      const installed = pluginFolder(world.project, "gh-cli");
      await writeFile(join(installed, "hooks", "setup.sh"), "echo edited\n");

      const r = await run([
        "share",
        "plugins/gh-cli",
        "--adopt",
        "-m",
        "adopt",
        "--yes",
      ]);
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString();
      expect(out).toContain("✓ adopted local/data/plugins/gh-cli @ ");
      expect(out).toContain(
        "provenance recorded in plugins/gh-cli/.capshelf.yml:",
      );
      expect(out).toContain("released: remote row for plugins/gh-cli");

      const shelfCopy = join(world.dataRepo, "plugins", "gh-cli");
      expect(
        await readFile(join(shelfCopy, "hooks", "setup.sh"), "utf-8"),
      ).toBe("echo edited\n");
      expect(existsSync(join(shelfCopy, ".claude-plugin", "plugin.json"))).toBe(
        true,
      );
      const sidecar = await readFile(join(shelfCopy, ".capshelf.yml"), "utf-8");
      expect(sidecar).toContain("upstream: ");
      expect(sidecar).toMatch(/^upstreamCommit: [0-9a-f]{40}$/m);
      expect(sidecar).toContain("upstreamPath: plugins/gh-cli");
      expect(
        (
          await $`git -C ${world.dataRepo} status --porcelain`.quiet().text()
        ).trim(),
      ).toBe("");

      const localLock = await readJsonObject(
        join(world.project, ".capshelf", "local.lock.json"),
      );
      expect(Object.keys(objectField(localLock, "items"))).toContain(
        "data/plugins/gh-cli",
      );
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );
      const remotes = await readJsonObject(remotesLockPath(world.project));
      expect(objectField(remotes, "items")).toEqual({});
      // M3: the sidecar stays on the shelf, never in the installed copy.
      expect(existsSync(join(installed, ".capshelf.yml"))).toBe(false);
      expect(
        await readFile(join(installed, "hooks", "setup.sh"), "utf-8"),
      ).toBe("echo edited\n");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses beside a skills.sh row with the same name and touches neither row (D2 guard 5, D9)",
    async () => {
      const { world, run } = await remotePluginWorld();
      const skillsLock = join(world.project, "skills-lock.json");
      await writeFile(
        skillsLock,
        `${JSON.stringify(
          {
            version: 1,
            skills: {
              "gh-cli": {
                source: "someone/skills",
                sourceType: "github",
                skillPath: "skills/gh-cli/SKILL.md",
                computedHash: "abc",
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const before = await readFile(skillsLock);
      const remotesBefore = await readFile(remotesLockPath(world.project));
      const headBefore = await headOf(world.dataRepo);

      const r = await run(["share", "plugins/gh-cli", "--adopt", "--yes"]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        ".agents/skills/gh-cli is already installed by skills.sh",
      );
      // D9: the skills.sh row is never found and never released.
      expect(await readFile(skillsLock)).toEqual(before);
      expect(await readFile(remotesLockPath(world.project))).toEqual(
        remotesBefore,
      );
      expect(await headOf(world.dataRepo)).toBe(headBefore);
      expect(existsSync(join(world.dataRepo, "plugins", "gh-cli"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--to project with no terminal refuses before any data-repo write (point 3)",
    async () => {
      const { world, run } = await remotePluginWorld();
      const headBefore = await headOf(world.dataRepo);
      const remotesBefore = await readFile(remotesLockPath(world.project));

      const r = await run([
        "share",
        "plugins/gh-cli",
        "--adopt",
        "--to",
        "project",
      ]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain("plugins/gh-cli");
      expect(err).toContain("without consent");
      expect(err).toContain("1 hook");
      expect(err).toContain("every teammate's");
      expect(err).toContain("--yes");
      expect(await headOf(world.dataRepo)).toBe(headBefore);
      expect(existsSync(join(world.dataRepo, "plugins", "gh-cli"))).toBe(false);
      expect(await readFile(remotesLockPath(world.project))).toEqual(
        remotesBefore,
      );
      expect(await lockKeys(world.project)).not.toContain(
        "data/plugins/gh-cli",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--to project --yes commits the plugin to project scope",
    async () => {
      const { world, run } = await remotePluginWorld();
      const r = await run([
        "share",
        "plugins/gh-cli",
        "--adopt",
        "--to",
        "project",
        "--yes",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain(
        "✓ adopted project/data/plugins/gh-cli @ ",
      );
      // `--yes` skips the question, so the authorized runs go to stderr.
      expect(r.stderr.toString()).toContain("every teammate's");
      expect(await lockKeys(world.project)).toContain("data/plugins/gh-cli");
      const manifest = await readJsonObject(manifestPath(world.project));
      expect(manifest.shelves).toBe(PLUGIN_FENCE);
      const remotes = await readJsonObject(remotesLockPath(world.project));
      expect(objectField(remotes, "items")).toEqual({});
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--to project answered no in a terminal writes nothing",
    async () => {
      const { world, run } = await remotePluginWorld();
      const headBefore = await headOf(world.dataRepo);
      const prompts: string[] = [];
      const outer = setDestructiveConfirmationContext({
        stdinIsTTY: true,
        stderrIsTTY: true,
        prompt: async (message) => {
          prompts.push(message);
          return "n";
        },
        stderr: { write: () => {} },
      });
      let r: CliResult;
      try {
        r = await run([
          "share",
          "plugins/gh-cli",
          "--adopt",
          "--to",
          "project",
        ]);
      } finally {
        setDestructiveConfirmationContext(outer);
      }
      expect(r.exitCode).toBe(0);
      expect(prompts).toEqual([
        "  plugins/gh-cli runs 1 hook.\n" +
          "  project scope commits it. The hooks then run in every teammate's\n" +
          "  Claude Code session after they trust this workspace.\n" +
          "Commit it to the project? [y/N] ",
      ]);
      expect(await headOf(world.dataRepo)).toBe(headBefore);
      const remotes = await readJsonObject(remotesLockPath(world.project));
      expect(Object.keys(objectField(remotes, "items"))).toEqual([
        "remote/plugins/gh-cli",
      ]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "warns when the license is at the repository root, outside the plugin",
    async () => {
      const { run } = await remotePluginWorld({ rootLicense: true });
      const r = await run(["share", "plugins/gh-cli", "--adopt", "--yes"]);
      expect(r.exitCode).toBe(0);
      const err = r.stderr.toString();
      expect(err).toMatch(
        /⚠ the license is at the file:\/\/\S+ root \(MIT\), not in the plugin/,
      );
      expect(err).toContain(
        "you are copying someone else's work into your shelf. Check the terms yourself.",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "does not warn when the license is inside the plugin",
    async () => {
      const { run } = await remotePluginWorld({ pluginLicense: true });
      const r = await run(["share", "plugins/gh-cli", "--adopt", "--yes"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr.toString()).not.toContain("license");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "prints the recorded upstream URL through the display sanitizer",
    async () => {
      const { world, run } = await remotePluginWorld();
      const remotesPath = remotesLockPath(world.project);
      const remotes = JSON.parse(await readFile(remotesPath, "utf-8"));
      const row = remotes.items["remote/plugins/gh-cli"];
      row.upstream = `${row.upstream}\u001b[31mred`;
      await writeFile(remotesPath, `${JSON.stringify(remotes, null, 2)}\n`);

      const r = await run(["share", "plugins/gh-cli", "--adopt", "--yes"]);
      expect(r.exitCode).toBe(0);
      const err = r.stderr.toString();
      // The edited URL has no warm cache, so the "no license" line names it.
      expect(err).toContain("no license file in the remote item or at the ");
      expect(err).not.toContain("\u001b");
      expect(r.stdout.toString()).toContain("upstream:       ");
      expect(r.stdout.toString()).not.toContain("\u001b");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a retry after an interrupted adopt releases remote/plugins/<n> only",
    async () => {
      // Constructed state, as in the skill test: the adopt runs to
      // completion, then the remotes lock is written back by hand. A second
      // remote row shows the retry releases only the plugin's own row.
      const { world, run } = await remotePluginWorld();
      const skillUpstream = await upstreamWith([["skills/pdf", "Extract"]]);
      expect(
        (await run(["add", skillUpstream.url, "--yes", "--json"])).exitCode,
      ).toBe(0);
      const remotesPath = remotesLockPath(world.project);
      const before = await readFile(remotesPath);
      expect(
        (await run(["share", "plugins/gh-cli", "--adopt", "--yes"])).exitCode,
      ).toBe(0);
      await writeFile(remotesPath, before);
      const headAfterFirst = await headOf(world.dataRepo);

      const retry = await run(["share", "plugins/gh-cli", "--adopt", "--json"]);
      expect(retry.exitCode).toBe(0);
      const payload = jsonOutput(retry);
      expect(payload.kind).toBe("plugins");
      expect(payload.action).toBe("already-upstream");
      expect(payload.adoptedFrom).toBe("remote");
      expect(payload.previousOwnerReleased).toBe(true);
      const remotes = await readJsonObject(remotesPath);
      expect(Object.keys(objectField(remotes, "items"))).toEqual([
        "remote/skills/pdf",
      ]);
      expect(await headOf(world.dataRepo)).toBe(headAfterFirst);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "refuses when the installed manifest names a different plugin (D3)",
    async () => {
      const { world, run } = await remotePluginWorld();
      await writeFile(
        join(
          pluginFolder(world.project, "gh-cli"),
          ".claude-plugin",
          "plugin.json",
        ),
        JSON.stringify({ name: "gh-tools" }),
      );
      const headBefore = await headOf(world.dataRepo);
      const r = await run(["share", "plugins/gh-cli", "--adopt", "--yes"]);
      expect(r.exitCode).toBe(3);
      const err = r.stderr.toString();
      expect(err).toContain('"gh-tools"');
      expect(err).toContain('"gh-cli"');
      expect(await headOf(world.dataRepo)).toBe(headBefore);
      const remotes = await readJsonObject(remotesLockPath(world.project));
      expect(Object.keys(objectField(remotes, "items"))).toEqual([
        "remote/plugins/gh-cli",
      ]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
