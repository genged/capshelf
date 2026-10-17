/**
 * `capshelf add <url> --path <plugin root>` installs the whole plugin as a
 * remote row (spec D3, D5, D6, D7 point 1, D8, D13).
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectField,
  runInProcess,
  stringField,
} from "./cli-fixtures";
import type { CliResult } from "./cli-fixtures";
import { claudeCatalog } from "./plugin-fixtures";
import type { PluginSpec } from "./plugin-fixtures";
import {
  initRemoteProject,
  pluginUpstream,
  upstreamWith,
} from "./remote-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { pluginRunsLines, renderPluginConsent } from "../src/plugin-consent";

const gh: PluginSpec = {
  dir: "plugins/gh-cli",
  manifestName: "gh-cli",
  skills: [{ name: "gh-cli", description: "GitHub CLI" }],
  files: {
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
        ],
      },
    }),
    "hooks/setup.sh": "echo hi\n",
    "agents/worker.md": "---\nname: worker\n---\n",
  },
};

/**
 * The folders under `.agents/skills`. `init` installs the bundled `capshelf`
 * skill there, so a refused install leaves exactly that one.
 */
async function installedSkillFolders(project: string): Promise<string[]> {
  return (await readdir(join(project, ".agents", "skills"))).sort();
}

/** Run with a terminal that answers each prompt from `answers`. */
async function runWithTerminal(
  project: string,
  env: Record<string, string>,
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
    return { result: await runInProcess(project)(args, env), prompts };
  } finally {
    setDestructiveConfirmationContext(outer);
  }
}

describe("add <url> --path <plugin root>", () => {
  test(
    "installs the whole plugin with --yes and records a plugins row",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const run = runInProcess(world.project);
      const r = await run(
        ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(0);
      const dir = join(world.project, ".agents", "skills", "gh-cli");
      expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(join(dir, "agents", "worker.md"))).toBe(true);
      expect(
        lstatSync(
          join(world.project, ".claude", "skills", "gh-cli"),
        ).isSymbolicLink(),
      ).toBe(true);
      const remotes = JSON.parse(
        await readFile(
          join(world.project, ".capshelf", "remotes.lock.json"),
          "utf-8",
        ),
      );
      expect(remotes.version).toBe(2);
      expect(Object.keys(remotes.items)).toEqual(["remote/plugins/gh-cli"]);
      const stdout = r.stdout.toString();
      expect(stdout).toContain("✓ added local/remote/plugins/gh-cli @ ");
      expect(stdout).toContain(
        "Claude Code loads it as gh-cli@skills-dir in a trusted workspace",
      );
      expect(stdout).toContain(
        "to give it to the team: capshelf share plugins/gh-cli --adopt",
      );
      // `--yes` skips the prompt, so the runs go to stderr instead.
      expect(r.stderr.toString()).toContain("bash hooks/setup.sh");
      const exclude = await readFile(
        join(world.project, ".git", "info", "exclude"),
        "utf-8",
      );
      expect(exclude).toContain(".agents/skills/gh-cli");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "with no terminal and no --yes it refuses and names the hooks",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/gh-cli"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain(
        "not installing plugins/gh-cli without consent — it runs 1 hook in every Claude Code session in this project",
      );
      expect(stderr).toContain("SessionStart");
      expect(stderr).toContain("bash hooks/setup.sh");
      expect(stderr).toContain("--yes");
      expect(
        existsSync(join(world.project, ".agents", "skills", "gh-cli")),
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the terminal prompt shows the plugin, its files, what it runs, and Codex's view",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const { result, prompts } = await runWithTerminal(
        world.project,
        world.env,
        ["add", up.url, "--path", "plugins/gh-cli"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toHaveLength(1);
      const block = prompts[0]!;
      expect(block).toContain("  path      plugins/gh-cli");
      expect(block).toContain(
        "  plugin    gh-cli  (.claude-plugin/plugin.json)",
      );
      expect(block).toContain(
        "  install   .agents/skills/gh-cli  (local scope, gitignored)",
      );
      expect(block).toMatch(/ {2}files {5}5 files, /);
      expect(block).toMatch(/skills\/\s+1 skill\s.*gh-cli:gh-cli/);
      expect(block).toMatch(/agents\/\s+1 agent\s.*gh-cli:worker/);
      expect(block).toContain(
        "  runs      1 hook, with no request from the agent",
      );
      expect(block).toMatch(/SessionStart\s+bash hooks\/setup\.sh/);
      expect(block).toContain(
        "These hooks run in every Claude Code session in this project.",
      );
      expect(block).toContain("  codex     sees the skills only");
      expect(block).toContain("  license   none found");
      expect(block).toMatch(/Install it\? \[y\/N\] $/);
      expect(
        existsSync(join(world.project, ".agents", "skills", "gh-cli")),
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "--as refuses for a plugin",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/gh-cli", "--as", "gh", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        'cannot rename a plugin: Claude Code names it from plugin.json ("gh-cli")',
      );
      expect(r.stderr.toString()).toContain(
        "agents are called as gh-cli:<agent>, whatever the directory name is",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an unsafe manifest name refuses before any write",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream(
        [{ ...gh, dir: "plugins/bad", manifestName: "../x" }],
        {},
      );
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/bad", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain("../x");
      expect(await installedSkillFolders(world.project)).toEqual(["capshelf"]);
      expect(
        existsSync(join(world.project, ".capshelf", "remotes.lock.json")),
      ).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a plugin root that is not a manifest name match uses the manifest name",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream(
        [
          {
            dir: "plugins/rr",
            manifestName: "rust-review",
            skills: [{ name: "rust-review", description: "Rust review" }],
          },
        ],
        {},
      );
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/rr", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(0);
      expect(
        existsSync(
          join(
            world.project,
            ".agents",
            "skills",
            "rust-review",
            ".claude-plugin",
            "plugin.json",
          ),
        ),
      ).toBe(true);
      expect(existsSync(join(world.project, ".agents", "skills", "rr"))).toBe(
        false,
      );
      const remotes = JSON.parse(
        await readFile(
          join(world.project, ".capshelf", "remotes.lock.json"),
          "utf-8",
        ),
      );
      expect(Object.keys(remotes.items)).toEqual([
        "remote/plugins/rust-review",
      ]);
      expect(remotes.items["remote/plugins/rust-review"].subpath).toBe(
        "plugins/rr",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a symlink in the plugin refuses with the plugin hint",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const shims = join(up.work, "plugins", "gh-cli", "hooks", "shims");
      await mkdir(shims, { recursive: true });
      await $`ln -s /usr/bin/pip3 ${join(shims, "pip3")}`.quiet();
      await commitAll(up.work, "add a symlink");
      await $`git -C ${up.work} push -q origin main`.quiet();
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain("unsupported Git entry");
      expect(stderr).toContain("hooks/shims/pip3");
      expect(stderr).toContain("this plugin cannot be installed by capshelf");
      expect(await installedSkillFolders(world.project)).toEqual(["capshelf"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the --json success row has kind plugins and a runs object",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/gh-cli", "--json", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(0);
      const payload = jsonOutput(r);
      expect(stringField(payload, "kind")).toBe("plugins");
      expect(stringField(payload, "name")).toBe("gh-cli");
      expect(stringField(payload, "subpath")).toBe("plugins/gh-cli");
      expect(objectField(payload, "runs")).toEqual({
        hooks: 1,
        mcpServers: 0,
        unknown: [],
      });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a second add of the same plugin at the same commit is already current",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const run = runInProcess(world.project);
      const args = ["add", up.url, "--path", "plugins/gh-cli", "--yes"];
      expect((await run(args, world.env)).exitCode).toBe(0);
      const again = await run(args, world.env);
      expect(again.exitCode).toBe(0);
      expect(again.stdout.toString()).toContain(
        "= already current local/remote/plugins/gh-cli @ ",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the --list footer names the whole-plugin install line",
    async () => {
      const line =
        "install a whole plugin:  capshelf add <url> --path plugins/<plugin>";
      const world = await initRemoteProject();
      // A plugin with no catalog entry is not listed, so the catalog names it.
      const up = await pluginUpstream([gh], {
        claude: claudeCatalog([{ name: "gh-cli", source: "./plugins/gh-cli" }]),
      });
      const listed = await runInProcess(world.project)(
        ["add", up.url, "--list"],
        world.env,
      );
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain(line);

      const skillsOnly = await upstreamWith([["skills/pdf", "PDF tools"]]);
      const plain = await runInProcess(world.project)(
        ["add", skillsOnly.url, "--list"],
        world.env,
      );
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout.toString()).not.toContain("install a whole plugin");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an existing remote skill with the same name refuses with the switch",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const run = runInProcess(world.project);
      const skill = await run(
        ["add", up.url, "--path", "plugins/gh-cli/skills/gh-cli", "--yes"],
        world.env,
      );
      expect(skill.exitCode).toBe(0);
      const r = await run(
        ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain(
        ".agents/skills/gh-cli is already installed by remote/skills/gh-cli",
      );
      expect(stderr).toContain("capshelf rm skills/gh-cli");
      expect(stderr).toContain(`capshelf add ${up.url} --path plugins/gh-cli`);
      expect(stderr).toContain(
        "after the switch, Claude Code calls the skill gh-cli:<skill>",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a remote skill refuses when a remote plugin owns the folder",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      const run = runInProcess(world.project);
      const plugin = await run(
        ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
        world.env,
      );
      expect(plugin.exitCode).toBe(0);
      const r = await run(
        ["add", up.url, "--path", "plugins/gh-cli/skills/gh-cli", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain(
        ".agents/skills/gh-cli is already installed by remote/plugins/gh-cli",
      );
      expect(stderr).toContain("capshelf rm plugins/gh-cli");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "an unmanaged folder at the install path refuses a plugin",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {});
      await mkdir(join(world.project, ".agents", "skills", "gh-cli"), {
        recursive: true,
      });
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        "the install path already exists and capshelf does not manage it",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a Codex-only plugin root keeps the step 1 refusal",
    async () => {
      const world = await initRemoteProject();
      const up = await pluginUpstream(
        [
          {
            dir: "plugins/cx",
            skills: [{ name: "cx", description: "Codex skill" }],
            files: { ".codex-plugin/plugin.json": '{"name":"cx"}' },
          },
        ],
        {},
      );
      const r = await runInProcess(world.project)(
        ["add", up.url, "--path", "plugins/cx", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain("plugins/cx is a plugin, not a skill");
      expect(stderr).toContain(
        "capshelf installs a whole plugin only when it holds .claude-plugin/plugin.json",
      );
      expect(await installedSkillFolders(world.project)).toEqual(["capshelf"]);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("plugin consent text", () => {
  test("pluginRunsLines says so when the plugin runs nothing", () => {
    expect(pluginRunsLines({ hooks: [], mcpServers: [], unknown: [] })).toEqual(
      ["no hooks, no MCP servers"],
    );
  });

  test("pluginRunsLines names hooks, servers, and unknown entries", () => {
    const lines = pluginRunsLines({
      hooks: [
        {
          event: "PreToolUse",
          matcher: "Bash",
          type: "command",
          command: "bash hooks/curl.sh",
          source: "hooks/hooks.json",
        },
      ],
      mcpServers: [
        {
          name: "db",
          command: "npx db-server",
          url: null,
          source: ".mcp.json",
        },
        {
          name: "web",
          command: null,
          url: "https://x.test",
          source: ".mcp.json",
        },
      ],
      unknown: ["hooks/extra.json could not be read"],
    });
    expect(lines[0]).toBe(
      "1 hook, 2 MCP servers, with no request from the agent",
    );
    expect(lines.join("\n")).toMatch(
      /PreToolUse\s+bash hooks\/curl\.sh\s+Bash/,
    );
    expect(lines.join("\n")).toMatch(/db\s+npx db-server/);
    expect(lines.join("\n")).toMatch(/web\s+https:\/\/x\.test/);
    expect(lines).toContain("  unknown: hooks/extra.json could not be read");
    expect(lines.at(-1)).toBe(
      "These hooks run in every Claude Code session in this project.",
    );
  });

  test("renderPluginConsent sanitizes every repository-controlled string", () => {
    const esc = "\u001b[2J";
    const lines = renderPluginConsent({
      repo: `https://x.test/r${esc}`,
      ref: `main${esc}`,
      commit: `abc${esc}`,
      path: `plugins/p${esc}`,
      name: "p",
      version: `1.0${esc}`,
      install: ".agents/skills/p",
      files: [
        { path: `skills/p${esc}/SKILL.md`, bytes: 10 },
        { path: `agents/a${esc}.md`, bytes: 5 },
      ],
      runs: {
        hooks: [
          {
            event: `Start${esc}`,
            matcher: null,
            type: "command",
            command: `run${esc}`,
            source: "hooks/hooks.json",
          },
        ],
        mcpServers: [],
        unknown: [],
      },
      license: `MIT${esc}`,
      description: `desc${esc}`,
    });
    expect(lines.join("\n")).not.toContain("\u001b");
  });
});
