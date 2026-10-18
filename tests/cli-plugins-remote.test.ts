/**
 * `capshelf add <url> --path <plugin root>` installs the whole plugin as a
 * remote row (spec D3, D5, D6, D7 point 1, D8, D13).
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  commitAll,
  jsonOutput,
  objectField,
  objectItems,
  runInProcess,
  stringField,
} from "./cli-fixtures";
import type { CliResult } from "./cli-fixtures";
import { claudeCatalog } from "./plugin-fixtures";
import type { PluginSpec } from "./plugin-fixtures";
import {
  initRemoteProject,
  pluginUpstream,
  pushPluginChange,
  upstreamWith,
} from "./remote-fixtures";
import type { RemoteProject, Upstream } from "./remote-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { lstatOrNull } from "../src/fs-utils";
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
    "D13: a --list with a plugin says Codex sees the skills only, in text output only",
    async () => {
      const codexLine = "  Codex sees the skills only.";
      const world = await initRemoteProject();
      const up = await pluginUpstream([gh], {
        claude: claudeCatalog([{ name: "gh-cli", source: "./plugins/gh-cli" }]),
      });
      const run = runInProcess(world.project);
      const listed = await run(["add", up.url, "--list"], world.env);
      expect(listed.exitCode).toBe(0);
      const lines = listed.stdout.toString().split("\n");
      // Directly under the footer line.
      const footer = lines.findIndex((l) =>
        l.includes("install a whole plugin"),
      );
      expect(lines[footer + 1]).toBe(codexLine);

      const scoped = await run(
        ["add", up.url, "--list", "--path", "plugins/gh-cli"],
        world.env,
      );
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stdout.toString()).toContain(
        `install a whole plugin:  capshelf add ${up.url} --path plugins/gh-cli`,
      );
      expect(scoped.stdout.toString()).toContain(codexLine);

      const json = await run(["add", up.url, "--list", "--json"], world.env);
      expect(json.exitCode).toBe(0);
      expect(json.stdout.toString()).not.toContain("Codex sees");

      const skillsOnly = await upstreamWith([["skills/pdf", "PDF tools"]]);
      const plain = await run(["add", skillsOnly.url, "--list"], world.env);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout.toString()).not.toContain("Codex sees");
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

/** The gh plugin's hooks with one more hook, a PostToolUse. */
const ghHooksWithFormat = JSON.stringify({
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
    ],
    PostToolUse: [
      { hooks: [{ type: "command", command: "bash hooks/format.sh" }] },
    ],
  },
});

/** A project with the gh plugin installed from its own upstream. */
async function installGh(): Promise<{
  world: RemoteProject;
  up: Upstream;
  run: ReturnType<typeof runInProcess>;
}> {
  const world = await initRemoteProject();
  const up = await pluginUpstream([gh], {});
  const run = runInProcess(world.project);
  const added = await run(
    ["add", up.url, "--path", "plugins/gh-cli", "--yes"],
    world.env,
  );
  expect(added.exitCode).toBe(0);
  return { world, up, run };
}

/** Push a new PostToolUse hook and its script to the gh plugin upstream. */
async function pushFormatHook(up: Upstream): Promise<void> {
  await pushPluginChange(up, "plugins/gh-cli/hooks/format.sh", "echo fmt\n");
  await pushPluginChange(
    up,
    "plugins/gh-cli/hooks/hooks.json",
    ghHooksWithFormat,
  );
}

/**
 * `update` reads the local cache only, so a pushed change reaches it through
 * the one command that fetches.
 */
async function fetchUpstream(
  run: ReturnType<typeof runInProcess>,
  world: RemoteProject,
): Promise<void> {
  const checked = await run(["status", "--check-upstream"], world.env);
  expect(checked.exitCode).toBe(0);
}

async function readRemotesLock(project: string): Promise<{
  version: number;
  items: Record<string, { sourceCommit: string; subpath: string }>;
}> {
  return JSON.parse(
    await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
  );
}

function ghDir(project: string): string {
  return join(project, ".agents", "skills", "gh-cli");
}

describe("remote plugin rows: update, apply, rm, status", () => {
  test(
    "update after a new hook refuses without consent and names the new hook",
    async () => {
      const { world, up, run } = await installGh();
      await pushFormatHook(up);
      await fetchUpstream(run, world);
      const refused = await run(["update", "plugins/gh-cli"], world.env);
      expect(refused.exitCode).toBe(3);
      const stderr = refused.stderr.toString();
      expect(stderr).toContain("+ 1 hook");
      expect(stderr).toContain("bash hooks/format.sh");
      expect(stderr).not.toContain("bash hooks/setup.sh");
      expect(existsSync(join(ghDir(world.project), "hooks", "format.sh"))).toBe(
        false,
      );

      const moved = await run(["update", "plugins/gh-cli", "--yes"], world.env);
      expect(moved.exitCode).toBe(0);
      expect(existsSync(join(ghDir(world.project), "hooks", "format.sh"))).toBe(
        true,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the pin-move prompt shows the version and only the new runs entries",
    async () => {
      const { world, up, run } = await installGh();
      await pushPluginChange(
        up,
        "plugins/gh-cli/.claude-plugin/plugin.json",
        JSON.stringify({ name: "gh-cli", version: "1.7.0" }),
      );
      await pushFormatHook(up);
      await fetchUpstream(run, world);
      const { result, prompts } = await runWithTerminal(
        world.project,
        world.env,
        ["update", "plugins/gh-cli"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toHaveLength(1);
      const block = prompts[0]!;
      expect(block).toContain(
        "  version   (none)  ->  1.7.0  (.claude-plugin/plugin.json)",
      );
      expect(block).toContain(
        "  runs      + 1 hook, with no request from the agent",
      );
      expect(block).toMatch(/PostToolUse\s+bash hooks\/format\.sh/);
      expect(block).not.toContain("bash hooks/setup.sh");
      expect(block).toMatch(/Move the pin\? \[y\/N\] $/);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update after a skill-only change still asks, with no runs line",
    async () => {
      const { world, up, run } = await installGh();
      await pushPluginChange(
        up,
        "plugins/gh-cli/skills/gh-cli/SKILL.md",
        "---\nname: gh-cli\ndescription: GitHub CLI, revised\n---\nbody\n",
      );
      await fetchUpstream(run, world);
      const { result, prompts } = await runWithTerminal(
        world.project,
        world.env,
        ["update", "plugins/gh-cli"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("skills/gh-cli/SKILL.md");
      expect(prompts[0]).not.toContain("  runs ");
      expect(prompts[0]).not.toContain("plugin facts could not be read");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update refuses a new tree that renames the plugin, before any write",
    async () => {
      const { world, up, run } = await installGh();
      await pushPluginChange(
        up,
        "plugins/gh-cli/.claude-plugin/plugin.json",
        JSON.stringify({ name: "gh-tools" }),
      );
      await fetchUpstream(run, world);
      const before = await readRemotesLock(world.project);
      const r = await run(["update", "plugins/gh-cli", "--yes"], world.env);
      expect(r.exitCode).toBe(3);
      const stderr = r.stderr.toString();
      expect(stderr).toContain('"gh-tools"');
      expect(stderr).toContain('"gh-cli"');
      expect(stderr).toContain("capshelf does not rename an item");
      expect(await readRemotesLock(world.project)).toEqual(before);
      const manifest = await readFile(
        join(ghDir(world.project), ".claude-plugin", "plugin.json"),
        "utf-8",
      );
      expect(JSON.parse(manifest).name).toBe("gh-cli");

      const dry = await run(
        ["update", "plugins/gh-cli", "--dry-run"],
        world.env,
      );
      expect(dry.exitCode).toBe(3);
      expect(dry.stderr.toString()).toContain(
        "capshelf does not rename an item",
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --merge refuses a merged tree whose local manifest renames the plugin",
    async () => {
      const { world, up, run } = await installGh();
      await writeFile(
        join(ghDir(world.project), ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "gh-tools" }),
      );
      await pushPluginChange(up, "plugins/gh-cli/README.md", "changed\n");
      await fetchUpstream(run, world);
      const before = await readRemotesLock(world.project);
      const r = await run(
        ["update", "plugins/gh-cli", "--merge", "--yes"],
        world.env,
      );
      expect(r.exitCode).toBe(3);
      expect(r.stderr.toString()).toContain(
        'plugins/gh-cli: the new tree names the plugin "gh-tools"',
      );
      expect(await readRemotesLock(world.project)).toEqual(before);
      expect(existsSync(join(ghDir(world.project), "README.md"))).toBe(false);
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "update --dry-run asks nothing and lists the new hook under would ask",
    async () => {
      const { world, up, run } = await installGh();
      await pushFormatHook(up);
      await fetchUpstream(run, world);
      const before = await readRemotesLock(world.project);
      const r = await run(["update", "plugins/gh-cli", "--dry-run"], world.env);
      expect(r.exitCode).toBe(0);
      const stdout = r.stdout.toString();
      expect(stdout).toContain("would update");
      expect(stdout).toContain(
        "  would ask + 1 hook, with no request from the agent",
      );
      expect(stdout).toMatch(/PostToolUse\s+bash hooks\/format\.sh/);
      expect(await readRemotesLock(world.project)).toEqual(before);
      expect(existsSync(join(ghDir(world.project), "hooks", "format.sh"))).toBe(
        false,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "status reports what a plugin row runs, and nothing for a skill row",
    async () => {
      const { world, run } = await installGh();
      const skills = await upstreamWith([["skills/pdf", "PDF tools"]]);
      expect(
        (await run(["add", skills.url, "--yes"], world.env)).exitCode,
      ).toBe(0);
      const json = await run(["status", "--json"], world.env);
      expect(json.exitCode).toBe(0);
      const rows = objectItems(jsonOutput(json), "items");
      const plugin = rows.find((row) => row.name === "gh-cli");
      expect(plugin?.kind).toBe("plugins");
      expect(plugin?.runs).toEqual({ hooks: 1, mcpServers: 0, unknown: [] });
      const skill = rows.find((row) => row.name === "pdf");
      expect(skill?.kind).toBe("skills");
      expect(skill !== undefined && "runs" in skill).toBe(false);

      const text = await run(["status"], world.env);
      const lines = text.stdout.toString().split("\n");
      const pluginLine = lines.find((line) => line.includes("plugins/gh-cli"));
      expect(pluginLine).toMatch(/ {2}hooks: 1$/);
      expect(pluginLine).not.toContain("MCP:");
      const skillLine = lines.find((line) => line.includes("skills/pdf"));
      expect(skillLine).not.toContain("hooks:");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "status counts the installed tree for a drifted plugin row",
    async () => {
      const { world, run } = await installGh();
      await writeFile(
        join(ghDir(world.project), "hooks", "hooks.json"),
        ghHooksWithFormat,
      );
      const json = await run(["status", "--json"], world.env);
      const rows = objectItems(jsonOutput(json), "items");
      const plugin = rows.find((row) => row.name === "gh-cli");
      expect(plugin?.runs).toEqual({ hooks: 2, mcpServers: 0, unknown: [] });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "status says runs: unknown when a declaration cannot be read",
    async () => {
      const { world, run } = await installGh();
      await writeFile(
        join(ghDir(world.project), "hooks", "hooks.json"),
        "{bad",
      );
      const json = await run(["status", "--json"], world.env);
      const rows = objectItems(jsonOutput(json), "items");
      expect(rows.find((row) => row.name === "gh-cli")?.runs).toEqual({
        hooks: 0,
        mcpServers: 0,
        unknown: ["hooks/hooks.json could not be read"],
      });
      const text = await run(["status"], world.env);
      const pluginLine = text.stdout
        .toString()
        .split("\n")
        .find((line) => line.includes("plugins/gh-cli"));
      expect(pluginLine).toMatch(/ {2}runs: unknown$/);
      expect(pluginLine).not.toContain("hooks:");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the pin-move prompt sanitizes the changed paths",
    async () => {
      const { world, up, run } = await installGh();
      await pushPluginChange(up, "plugins/gh-cli/notes\u001b[2J.md", "notes\n");
      await fetchUpstream(run, world);
      const { result, prompts } = await runWithTerminal(
        world.project,
        world.env,
        ["update", "plugins/gh-cli"],
        ["n"],
      );
      expect(result.exitCode).toBe(0);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("notes");
      expect(prompts[0]).not.toContain("\u001b");
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "status reads the pinned tree when the plugin folder is missing",
    async () => {
      const { world, run } = await installGh();
      await rm(ghDir(world.project), { recursive: true, force: true });
      const json = await run(["status", "--json"], world.env);
      const rows = objectItems(jsonOutput(json), "items");
      const plugin = rows.find((row) => row.name === "gh-cli");
      expect(plugin?.runs).toEqual({ hooks: 1, mcpServers: 0, unknown: [] });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "rm removes the plugin folder, its link, and its row",
    async () => {
      const { world, run } = await installGh();
      const r = await run(["rm", "plugins/gh-cli", "--yes"], world.env);
      expect(r.exitCode).toBe(0);
      expect(existsSync(ghDir(world.project))).toBe(false);
      expect(
        lstatOrNull(join(world.project, ".claude", "skills", "gh-cli")),
      ).toBe(null);
      const remotes = await readRemotesLock(world.project);
      expect(remotes).toEqual({ version: 1, items: {} });
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "apply restores a deleted plugin folder without asking",
    async () => {
      const { world, run } = await installGh();
      await rm(ghDir(world.project), { recursive: true, force: true });
      const r = await run(["apply", "plugins/gh-cli"], world.env);
      expect(r.exitCode).toBe(0);
      expect(
        existsSync(join(ghDir(world.project), ".claude-plugin", "plugin.json")),
      ).toBe(true);
      expect(existsSync(join(ghDir(world.project), "hooks", "setup.sh"))).toBe(
        true,
      );
    },
    CLI_INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("a bare name that matches two remote rows", () => {
  /**
   * The CLI cannot create this pair (D2 guard 5 refuses the second install),
   * so the test writes the second row into the remotes lock directly.
   */
  async function installPair(): Promise<{
    world: RemoteProject;
    run: ReturnType<typeof runInProcess>;
    before: string;
  }> {
    const { world, run } = await installGh();
    const path = join(world.project, ".capshelf", "remotes.lock.json");
    const lock = JSON.parse(await readFile(path, "utf-8"));
    lock.items["remote/skills/gh-cli"] = {
      ...lock.items["remote/plugins/gh-cli"],
      subpath: "plugins/gh-cli/skills/gh-cli",
    };
    const before = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(path, before);
    return { world, run, before };
  }

  for (const args of [
    ["rm", "gh-cli", "--yes"],
    ["apply", "gh-cli"],
    ["update", "gh-cli", "--yes"],
  ]) {
    test(
      `${args[0]} refuses as ambiguous and writes nothing`,
      async () => {
        const { world, run, before } = await installPair();
        const r = await run(args, world.env);
        expect(r.exitCode).toBe(3);
        expect(r.stderr.toString()).toContain(
          'ambiguous item "gh-cli": found plugins/gh-cli, skills/gh-cli; use kind/name',
        );
        expect(
          await readFile(
            join(world.project, ".capshelf", "remotes.lock.json"),
            "utf-8",
          ),
        ).toBe(before);
        expect(
          existsSync(
            join(ghDir(world.project), ".claude-plugin", "plugin.json"),
          ),
        ).toBe(true);
      },
      CLI_INTEGRATION_TEST_TIMEOUT_MS,
    );
  }
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
          command: "npx",
          args: ["db-server", "--name", "my db"],
          url: null,
          source: ".mcp.json",
        },
        {
          name: "web",
          command: null,
          args: [],
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
    expect(lines.join("\n")).toMatch(/db\s+npx db-server --name 'my db'/);
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
