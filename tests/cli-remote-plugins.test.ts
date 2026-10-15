/**
 * `capshelf add <url> --list`, text and JSON, for a repository that publishes
 * Claude/Codex plugins.
 *
 * Fixtures use `pluginUpstream` (`tests/remote-fixtures.ts`), which writes
 * plugin directories with `writePlugins` (`tests/plugin-fixtures.ts`) and
 * commits them to a local bare repository, the same pattern
 * `tests/cli-remote-add.test.ts` uses for its non-plugin cases.
 */
import { expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  arrayField,
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
  skillText,
  upstreamWith,
} from "./remote-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import type { DestructiveConfirmationContext } from "../src/destructive-change";
import { setPickContext } from "../src/pick";
import { pickRowId } from "../src/pick-core";
import type { DiscoveredPlugin } from "../src/plugin-discovery";
import type {
  RemoteDiscovery,
  RemoteSkillCandidate,
} from "../src/remote-discovery";
import { renderCandidateList } from "../src/remote-list-render";

const initProject = initRemoteProject;

const HEAVY_BODY = `Reads \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh and dispatches heavy:assistant. See [a](../../AGENTS.md) for the shared rules.\n`;

/**
 * `plain` (one skill, no facts), `heavy` (one skill named `worker` that
 * matches `plugin root`, `agents`, and `outside links`), and `empty` (no
 * skill directory, only `commands/`) — the fixture for the grouping,
 * uses-column, and no-skills-line behaviors.
 *
 * The agent is named `assistant`, not `worker`: a reference to the skill's
 * own namespaced name does not count (`src/plugin-facts.ts`'s self-reference
 * exclusion), so naming it the same as the skill would silently drop the
 * `plugin-agents` match this fixture means to exercise.
 */
function threePlugins(): PluginSpec[] {
  return [
    {
      dir: "plugins/plain",
      skills: [{ name: "plain", description: "Plain skill" }],
    },
    {
      dir: "plugins/heavy",
      skills: [
        { name: "worker", description: "Heavy skill", body: HEAVY_BODY },
      ],
      files: {
        "agents/assistant.md": "agent\n",
        "scripts/x.sh": "#!/bin/sh\n",
        "hooks/hooks.json": "{}\n",
      },
    },
    {
      dir: "plugins/empty",
      skills: [],
      files: { "commands/c.md": "# c\n" },
    },
  ];
}

function threePluginsCatalog() {
  return claudeCatalog([
    { name: "plain", source: "./plugins/plain" },
    { name: "heavy", source: "./plugins/heavy" },
    { name: "empty", source: "./plugins/empty" },
  ]);
}

/** Two plugins that each hold a skill directory named `x`, so their default
 * install name collides (D6). */
function duplicateNamePlugins(): PluginSpec[] {
  return [
    { dir: "plugins/a", skills: [{ name: "x", description: "A's x" }] },
    { dir: "plugins/b", skills: [{ name: "x", description: "B's x" }] },
  ];
}

function duplicateNameCatalog() {
  return claudeCatalog([
    { name: "a", source: "./plugins/a" },
    { name: "b", source: "./plugins/b" },
  ]);
}

/**
 * A plugin whose manifest names its own directory as a skill
 * (`"skills": "./"`), so `plugins/x` is both the plugin's `source` and one
 * of its own `skillDirs` — the shape D5 must not mistake for a plugin root.
 */
function selfSkillPlugin(): PluginSpec[] {
  return [
    {
      dir: "plugins/x",
      manifestName: "x",
      manifestSkills: "./",
      skills: [],
      files: {
        "SKILL.md": "---\nname: x\ndescription: Self-skill plugin\n---\nbody\n",
      },
    },
  ];
}

function selfSkillCatalog() {
  return claudeCatalog([{ name: "x", source: "./plugins/x" }]);
}

/**
 * Every regular file under `root`, as `relativePath:base64Content`, sorted —
 * a before/after comparison proves a refused command left the project
 * untouched without trusting `git status`, which a refusal might not even
 * dirty. `.git` is excluded: its own internal bookkeeping (packed-refs,
 * reflogs) can change between two reads of a repository nothing else wrote to.
 */
async function projectSnapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        out.push(`${relPath}:${(await readFile(abs)).toString("base64")}`);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

test(
  "--list groups skills by plugin, shows their uses, and names the no-skills plugin",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("  plugins/plain");
    expect(stdout).toContain(
      "  plugins/heavy   also ships: agents, hooks, scripts",
    );
    expect(stdout).toContain("uses plugin root, agents, outside links");
    expect(stdout).toContain("no skills  plugins/empty  (commands only)");
    expect(stdout).toContain(
      `install one:   capshelf add ${url} --path plugins/plain/skills/plain`,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list --json reports plugin rows, uses, and the plugin and skipped arrays",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    const skills = objectItems(payload, "skills");
    expect(skills).toHaveLength(2);
    expect(arrayField(payload, "plugins")).toHaveLength(3);

    const heavy = skills.find((s) => stringField(s, "name") === "worker");
    expect(heavy).toBeDefined();
    expect(arrayField(heavy!, "usesPluginParts")).toHaveLength(3);
    expect(stringField(heavy!, "origin")).toBe("marketplace");

    const plain = skills.find((s) => stringField(s, "name") === "plain");
    expect(plain).toBeDefined();
    expect(arrayField(plain!, "usesPluginParts")).toEqual([]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list --json on a repository with no plugin has empty plugin arrays",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    expect(arrayField(payload, "plugins")).toEqual([]);
    expect(arrayField(payload, "skipped")).toEqual([]);
    expect(arrayField(payload, "warnings")).toEqual([]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list --path lists one plugin only, with the real singular rule",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--path", "plugins/heavy"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("found     1 skill in plugins/heavy");
    expect(stdout).not.toContain("plain");
    expect(stdout).not.toContain("plugins/empty");
    expect(stdout).toContain(
      `install one:   capshelf add ${url} --path plugins/heavy/skills/worker`,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list --path plugins/heavy --json reports only that plugin and its skills",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--path", "plugins/heavy", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    const plugins = arrayField(payload, "plugins");
    expect(plugins).toHaveLength(1);
    const skills = objectItems(payload, "skills");
    expect(skills).toHaveLength(1);
    expect(stringField(skills[0]!, "name")).toBe("worker");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

// D2: a capshelf-shaped shelf (a legacy `source: "./"` entry with a `skills`
// array, plus a generated Codex catalog entry under `codex/generated/`) must
// list exactly as it did before this feature. The expected text below is the
// literal output of `bun run src/cli.ts add <url> --list` at `d8b8168` (the
// commit before plugin discovery existed), run against this same fixture
// shape in a scratch worktree, with the URL and commit substituted for this
// run's own values — both differ on every run because the fixture
// repository is created fresh.
test(
  "a capshelf-shaped shelf with a generated Codex catalog lists byte-identical to before this feature",
  async () => {
    const { url, work } = await upstreamWith([["skills/pdf", "Extract text"]]);
    await mkdir(join(work, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(work, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "example",
        owner: { name: "example" },
        plugins: [
          {
            name: "pdf",
            source: "./",
            strict: false,
            skills: ["./skills/pdf"],
          },
        ],
      }),
    );
    await mkdir(join(work, ".agents", "plugins"), { recursive: true });
    await writeFile(
      join(work, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "pdf",
            source: { source: "local", path: "./codex/generated/plugins/x" },
          },
        ],
      }),
    );
    await $`git -C ${work} add -A`.quiet();
    await $`git -C ${work} commit -qm "shelf-shaped with codex catalog"`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();
    const commit = (
      await $`git -C ${work} rev-parse HEAD`.quiet().text()
    ).trim();

    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      [
        `  repo      ${url}`,
        "  ref       main",
        `  commit    ${commit}`,
        "  found     1 skill",
        "",
        "    skills/pdf   Extract text",
        "",
        `  install one:   capshelf add ${url} --path skills/pdf`,
        `  install some:  capshelf add ${url}`,
        "",
      ].join("\n"),
    );
    expect(result.stderr.toString()).toBe("");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "an external-source catalog entry prints the elsewhere line",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/local",
          skills: [{ name: "local", description: "Local plugin" }],
        },
      ],
      {
        claude: claudeCatalog([
          { name: "local", source: "./plugins/local" },
          {
            name: "faraway",
            source: { source: "github", repo: "owner/faraway" },
          },
        ]),
      },
    );
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      "elsewhere  faraway  (sources outside this repository, not read)",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a catalog with only an external-source entry names it in the elsewhere line",
  async () => {
    const { url, work } = await pluginUpstream([], {
      claude: claudeCatalog([
        {
          name: "faraway",
          source: { source: "github", repo: "owner/faraway" },
        },
      ]),
    });
    const commit = (
      await $`git -C ${work} rev-parse HEAD`.quiet().text()
    ).trim();
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(
      [
        `  repo      ${url}`,
        "  ref       main",
        `  commit    ${commit}`,
        "  found     0 skills",
        "  elsewhere  faraway  (sources outside this repository, not read)",
        "",
      ].join("\n"),
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a skipped catalog entry other than external-source warns on stderr with its reason",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/local",
          skills: [{ name: "local", description: "Local plugin" }],
        },
      ],
      {
        // A bare name with no document-level `metadata.pluginRoot` is
        // `unsafe-path` (`src/plugin-discovery.ts`'s `resolveClaudeSource`),
        // not `external-source` — it names a directory in this repository,
        // just not safely, so it is a warning, not an `elsewhere` entry.
        claude: claudeCatalog([
          { name: "local", source: "./plugins/local" },
          { name: "bare-name-plugin", source: "bare-name-plugin" },
        ]),
      },
    );
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain(
      '⚠ claude catalog entry "bare-name-plugin": unsafe source bare-name-plugin, skipped',
    );
    expect(result.stdout.toString()).not.toContain("elsewhere");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "install one quotes a subpath that holds a space",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/weird one",
          skills: [{ name: "plain", description: "Plain skill" }],
        },
      ],
      {
        claude: claudeCatalog([
          { name: "weird", source: "./plugins/weird one" },
        ]),
      },
    );
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(
      `install one:   capshelf add ${url} --path 'plugins/weird one/skills/plain'`,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test("renderCandidateList's summaryLength stops right after the summary block's blank line", () => {
  const candidate: RemoteSkillCandidate = {
    subpath: "plugins/a/skills/x",
    defaultName: "x",
    description: "X",
    origin: "marketplace",
    plugin: {
      plugin: {
        name: "a",
        source: "plugins/a",
        catalogs: ["claude"],
        ships: [],
      },
      usesPluginParts: [],
      factsComplete: true,
      unread: [],
      filesOutsideSkill: 0,
    },
  };
  const pluginA: DiscoveredPlugin = {
    name: "a",
    source: "plugins/a",
    catalogs: ["claude"],
    ships: [],
    skillDirs: ["plugins/a/skills/x"],
  };
  const pluginB: DiscoveredPlugin = {
    name: "b",
    source: "plugins/b",
    catalogs: ["claude"],
    ships: ["commands"],
    skillDirs: [],
  };
  const discovery: RemoteDiscovery = {
    candidates: [candidate],
    plugins: [pluginA, pluginB],
    skipped: [],
    warnings: [],
  };
  const { lines, summaryLength } = renderCandidateList({
    url: "https://example.invalid/repo",
    upstream: "https://example.invalid/repo",
    ref: "main",
    commit: "abc123",
    discovery,
    scope: "repository",
  });
  // `b` has no skill directory, so it only appears in the "no skills" line,
  // not as a group — the summary block ends right after that line and the
  // one blank line, before `a`'s group starts.
  expect(lines.slice(0, summaryLength)).toEqual([
    "  repo      https://example.invalid/repo",
    "  ref       main",
    "  commit    abc123",
    "  found     1 skill in 1 plugin  (.claude-plugin/marketplace.json)",
    "  no skills  plugins/b  (commands only)",
    "",
  ]);
  expect(lines[summaryLength]).toBe("  plugins/a");
});

interface D9Harness {
  context: DestructiveConfirmationContext;
  prompts: string[];
}

/**
 * D9's confirmation context: three TTYs and a terminal short enough (5 rows)
 * that the three-plugin fixture's listing — 2 skills, well over 5 lines once
 * the plugin groups and the footer print — always crosses the threshold.
 * `answers` is consumed in call order; a test that expects more than one
 * prompt call must queue enough of them.
 */
function d9Context(
  answers: readonly string[],
  overrides: Partial<DestructiveConfirmationContext> = {},
): D9Harness {
  const prompts: string[] = [];
  const queue = [...answers];
  return {
    context: {
      stdinIsTTY: true,
      stderrIsTTY: true,
      stdoutIsTTY: true,
      terminalRows: 5,
      prompt: async (message) => {
        prompts.push(message);
        const next = queue.shift();
        if (next === undefined) {
          throw new Error("d9Context: no answer queued for this prompt call");
        }
        return next;
      },
      stderr: { write: () => {} },
      ...overrides,
    },
    prompts,
  };
}

async function runWithConfirmation(
  project: string,
  env: Record<string, string>,
  args: string[],
  context: DestructiveConfirmationContext,
) {
  const outer = setDestructiveConfirmationContext(context);
  try {
    return await runInProcess(project)(args, env);
  } finally {
    setDestructiveConfirmationContext(outer);
  }
}

test(
  "D9: a listing taller than the terminal asks once, and enter shows the rest",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context([""]);
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith("Show all 2 skills (");
    const stdout = result.stdout.toString();
    expect(stdout).toContain("  plugins/plain");
    expect(stdout).toContain("  plugins/heavy");
    expect(stdout).toContain(
      `install one:   capshelf add ${url} --path plugins/plain/skills/plain`,
    );
    // The question's line count is `renderCandidateList(...).lines.length`
    // (`src/remote-list-render.ts`), and answering "" here prints every one
    // of those lines via one `console.log` call each — the summary half, then
    // the rest — so the total lines this run printed must equal the number
    // the question quoted.
    const match = /\((\d+) lines\)/.exec(prompts[0]!);
    expect(match).not.toBeNull();
    const totalPrintedLines = stdout.split("\n").length - 1;
    expect(Number(match![1])).toBe(totalPrintedLines);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: 'n' prints the plugin-scoped and JSON commands, no skill rows, exit 0",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context(["n"]);
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(
      `  one plugin:   capshelf add ${url} --list --path plugins/plain`,
    );
    expect(stdout).toContain(
      `  everything:   capshelf add ${url} --list --json`,
    );
    expect(stdout).not.toContain("  plugins/heavy");
    expect(stdout).not.toContain("install one:");
    // The summary block (through the `found` line) always prints, and it
    // prints before the "no" text, not instead of it.
    // `plugins/empty` ships no skill, so the count names only the two
    // plugins that do.
    const foundIndex = stdout.indexOf("  found     2 skills in 2 plugins");
    const noTextIndex = stdout.indexOf("  one plugin:");
    expect(foundIndex).toBeGreaterThanOrEqual(0);
    expect(noTextIndex).toBeGreaterThan(foundIndex);
    // No skill row — only a plugin group header carries this text — reached
    // stdout: the descriptions below only appear on a skill's own row.
    expect(stdout).not.toContain("Plain skill");
    expect(stdout).not.toContain("Heavy skill");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: an answer that is neither yes nor no asks again",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context(["maybe", "y"]);
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(result.stdout.toString()).toContain(
      `install one:   capshelf add ${url} --path plugins/plain/skills/plain`,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: a rejected prompt (end of input) acts as 'no'",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const prompts: string[] = [];
    const context: DestructiveConfirmationContext = {
      stdinIsTTY: true,
      stderrIsTTY: true,
      stdoutIsTTY: true,
      terminalRows: 5,
      prompt: async (message) => {
        prompts.push(message);
        throw new Error("EOF");
      },
      stderr: { write: () => {} },
    };
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(
      `  one plugin:   capshelf add ${url} --list --path plugins/plain`,
    );
    expect(stdout).not.toContain("  plugins/heavy");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: a terminal tall enough never asks",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context([], { terminalRows: 500 });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(result.stdout.toString()).toContain("  plugins/heavy");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: stdout that is not a terminal never asks",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context([], { stdoutIsTTY: false });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(result.stdout.toString()).toContain("  plugins/heavy");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: --json never asks, even with a short terminal",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context([]);
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list", "--json"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    const payload = jsonOutput(result);
    expect(arrayField(payload, "plugins")).toHaveLength(3);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: a shelf with no plugin skill never asks, even with a one-row terminal (D2)",
  async () => {
    const { url } = await upstreamWith([["skills/pdf", "Extract text"]]);
    const { project, env } = await initProject();
    const { context, prompts } = d9Context([], { terminalRows: 1 });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    expect(result.stdout.toString()).toContain("skills/pdf");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: a commands-only plugin never asks, even with enough layout skills to exceed the terminal",
  async () => {
    // `discovery.plugins` holds a plugin with no skill directories too; D9
    // must count plugins that have a skill, not every catalog entry.
    const { url, work } = await upstreamWith([
      ["skills/a", "A"],
      ["skills/b", "B"],
      ["skills/c", "C"],
      ["skills/d", "D"],
      ["skills/e", "E"],
      ["skills/f", "F"],
    ]);
    await mkdir(join(work, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(work, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "example",
        owner: { name: "example" },
        plugins: [{ name: "cmds", source: "./plugins/cmds" }],
      }),
    );
    await mkdir(join(work, "plugins", "cmds", "commands"), {
      recursive: true,
    });
    await writeFile(join(work, "plugins", "cmds", "commands", "c.md"), "# c\n");
    await $`git -C ${work} add -A`.quiet();
    await $`git -C ${work} commit -qm "commands-only plugin"`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();

    const { project, env } = await initProject();
    const { context, prompts } = d9Context([], { terminalRows: 5 });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(0);
    const stdout = result.stdout.toString();
    // No plugin holds a skill, so the found line names no plugin count and
    // no catalog.
    expect(stdout.split("\n")).toContain("  found     6 skills");
    expect(stdout).toContain("no skills  plugins/cmds");
    expect(stdout).toContain("skills/a");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: 'no' names the first plugin with a skill, skipping a commands-only plugin listed first",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/empty",
          skills: [],
          files: { "commands/c.md": "# c\n" },
        },
        {
          dir: "plugins/withskills",
          skills: [
            { name: "a", description: "A" },
            { name: "b", description: "B" },
          ],
        },
      ],
      {
        claude: claudeCatalog([
          { name: "empty", source: "./plugins/empty" },
          { name: "withskills", source: "./plugins/withskills" },
        ]),
      },
    );
    const { project, env } = await initProject();
    const { context, prompts } = d9Context(["n"], { terminalRows: 3 });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(
      `  one plugin:   capshelf add ${url} --list --path plugins/withskills`,
    );
    expect(stdout).not.toContain("--path plugins/empty");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: a plugin-scoped listing's 'no' text omits the redundant plugin command",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = d9Context(["n"], { terminalRows: 3 });
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--list", "--path", "plugins/heavy"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    const stdout = result.stdout.toString();
    expect(stdout).not.toContain("one plugin:");
    // The JSON command stays in the plugin's scope. The whole-repository
    // command would show more than the user asked for.
    expect(stdout).toContain(
      `  everything:   capshelf add ${url} --list --path plugins/heavy --json`,
    );
    expect(stdout).not.toContain(`capshelf add ${url} --list --json`);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D5: a plugin root at --path refuses, names the skill and its uses, and leaves the project untouched",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const before = await projectSnapshot(project);
    const result = await runInProcess(project)(
      ["add", url, "--path", "plugins/heavy"],
      env,
    );
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "plugins/heavy is a plugin, not a skill. It holds 1 skill:",
    );
    expect(stderr).toContain(
      "plugins/heavy/skills/worker   uses plugin root, agents, outside links",
    );
    expect(stderr).toContain(
      `install the skill: capshelf add ${url} --path plugins/heavy/skills/worker`,
    );
    expect(stderr).toContain("capshelf cannot install a whole plugin");
    expect(stderr).not.toContain("claude plugin");
    expect(stderr).not.toContain("codex plugin");
    const after = await projectSnapshot(project);
    expect(after).toEqual(before);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D5: a plugin root with no skills refuses with 'is a plugin with no skills'",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "plugins/empty"],
      env,
    );
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("plugins/empty is a plugin with no skills");
    expect(stderr).toContain("capshelf cannot install a whole plugin");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D5: a plugin root that is also one of its own skill directories installs normally",
  async () => {
    const { url } = await pluginUpstream(selfSkillPlugin(), {
      claude: selfSkillCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "plugins/x", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, ".agents/skills/x/SKILL.md"))).toBe(true);
    const payload = jsonOutput(result);
    expect(stringField(payload, "name")).toBe("x");
    expect(stringField(objectField(payload, "plugin"), "name")).toBe("x");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D5: a self-skill plugin root prints the plugin's warnings before it installs",
  async () => {
    // The catalog names the plugin "y" and its manifest names it "x", so
    // reading the plugin warns about the disagreement.
    const { url } = await pluginUpstream(selfSkillPlugin(), {
      claude: claudeCatalog([{ name: "y", source: "./plugins/x" }]),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "plugins/x", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain(
      "⚠ plugins/x catalogs and manifests name it y; shown as x",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D6: two selected skills with the same install name refuse before any project write",
  async () => {
    const { url } = await pluginUpstream(duplicateNamePlugins(), {
      claude: duplicateNameCatalog(),
    });
    const { project, env } = await initProject();
    const excludePath = join(project, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf-8");
    const outer = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows.map(pickRowId),
      }),
    });
    let result: CliResult;
    try {
      result = await runInProcess(project)(["add", url, "--yes"], env);
    } finally {
      setPickContext(outer);
    }
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      '2 selected skills would install as "x": plugins/a/skills/x, plugins/b/skills/x',
    );
    expect(stderr).toContain(
      `install them one at a time: capshelf add ${url} --path <subpath> --as <name>`,
    );
    expect(existsSync(join(project, ".capshelf", "remotes.lock.json"))).toBe(
      false,
    );
    expect(existsSync(join(project, ".agents", "skills", "x"))).toBe(false);
    // `ensureLocalExcludes` writes this file; the refusal runs before any
    // install reaches it, so it must be untouched too.
    expect(await readFile(excludePath, "utf-8")).toBe(excludeBefore);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D6: every colliding name is named, not only the first",
  async () => {
    const { url } = await pluginUpstream(
      [
        { dir: "plugins/a", skills: [{ name: "x", description: "A's x" }] },
        { dir: "plugins/b", skills: [{ name: "x", description: "B's x" }] },
        { dir: "plugins/c", skills: [{ name: "y", description: "C's y" }] },
        { dir: "plugins/d", skills: [{ name: "y", description: "D's y" }] },
      ],
      {
        claude: claudeCatalog([
          { name: "a", source: "./plugins/a" },
          { name: "b", source: "./plugins/b" },
          { name: "c", source: "./plugins/c" },
          { name: "d", source: "./plugins/d" },
        ]),
      },
    );
    const { project, env } = await initProject();
    const outer = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows.map(pickRowId),
      }),
    });
    let result: CliResult;
    try {
      result = await runInProcess(project)(["add", url, "--yes"], env);
    } finally {
      setPickContext(outer);
    }
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      '2 selected skills would install as "x": plugins/a/skills/x, plugins/b/skills/x',
    );
    expect(stderr).toContain(
      '2 selected skills would install as "y": plugins/c/skills/y, plugins/d/skills/y',
    );
    expect(stderr).toContain(
      `install them one at a time: capshelf add ${url} --path <subpath> --as <name>`,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D6: listing two same-name skills is not an error",
  async () => {
    const { url } = await pluginUpstream(duplicateNamePlugins(), {
      claude: duplicateNameCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("plugins/a");
    expect(stdout).toContain("plugins/b");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D6: selecting one of two same-name skills installs normally",
  async () => {
    const { url } = await pluginUpstream(duplicateNamePlugins(), {
      claude: duplicateNameCatalog(),
    });
    const { project, env } = await initProject();
    const outer = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows
          .filter((row) => row.id === "plugins/a/skills/x")
          .map(pickRowId),
      }),
    });
    let result: CliResult;
    try {
      result = await runInProcess(project)(["add", url, "--yes"], env);
    } finally {
      setPickContext(outer);
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, ".agents/skills/x/SKILL.md"))).toBe(true);
    const lock = JSON.parse(
      await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
    );
    expect(Object.keys(lock.items)).toEqual(["remote/skills/x"]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

interface ConsentHarness {
  context: DestructiveConfirmationContext;
  prompts: string[];
}

/** A TTY confirmation context for the per-skill consent prompt
 * (`confirmInstall`), answering "n" so the run exits 0 without installing. */
function consentContext(): ConsentHarness {
  const prompts: string[] = [];
  return {
    context: {
      stdinIsTTY: true,
      stderrIsTTY: true,
      prompt: async (message) => {
        prompts.push(message);
        return "n";
      },
      stderr: { write: () => {} },
    },
    prompts,
  };
}

test(
  "consent for a skill with facts names the plugin and the facts that reach outside it",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = consentContext();
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--path", "plugins/heavy/skills/worker"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("plugin    heavy");
    expect(prompt).toContain(
      "! this skill uses parts of the heavy plugin that are not installed:",
    );
    // The agent fact names the agent the skill's text refers to ("assistant"),
    // not the skill's own name ("worker") — the self-reference exclusion in
    // `src/plugin-facts.ts` means the skill's own name never appears here.
    // The column width is the widest label *present* (here, "outside links",
    // 13 chars) plus 2 — so "agents" and "plugin root" pad to 15, not 13.
    expect(prompt).toContain("agents         assistant");
    expect(prompt).toContain("outside links  ../../AGENTS.md");
    expect(prompt).toContain("files outside the skill directory");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "consent for a skill with no facts shows '(no parts outside the skill)' and the singular file count",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const { context, prompts } = consentContext();
    const result = await runWithConfirmation(
      project,
      env,
      ["add", url, "--path", "plugins/plain/skills/plain"],
      context,
    );
    expect(result.exitCode).toBe(0);
    const prompt = prompts[0]!;
    expect(prompt).toContain("plugin    plain  (no parts outside the skill)");
    expect(prompt).toContain("1 file,");
    expect(prompt).not.toContain("uses parts of the plain plugin");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--yes --json installing a skill with facts prints the facts block to stderr and usesPluginParts in the JSON row",
  async () => {
    const { url } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    const { project, env } = await initProject();
    const result = await runInProcess(project)(
      ["add", url, "--path", "plugins/heavy/skills/worker", "--yes", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const stderr = result.stderr.toString();
    expect(stderr).toContain(
      "! this skill uses parts of the heavy plugin that are not installed:",
    );
    expect(stderr).toContain("outside links  ../../AGENTS.md");
    expect(stderr).toContain("files outside the skill directory");
    const payload = jsonOutput(result);
    expect(arrayField(payload, "usesPluginParts")).toHaveLength(3);
    expect(stringField(objectField(payload, "plugin"), "name")).toBe("heavy");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the multi-result JSON carries plugin fields only on the plugin skill's row",
  async () => {
    const { url, work } = await pluginUpstream(threePlugins(), {
      claude: threePluginsCatalog(),
    });
    await mkdir(join(work, "skills", "pdf"), { recursive: true });
    await writeFile(
      join(work, "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: Extract text\n---\nbody\n",
    );
    await $`git -C ${work} add -A`.quiet();
    await $`git -C ${work} commit -qm "add a layout skill"`.quiet();
    await $`git -C ${work} push -q origin main`.quiet();

    const { project, env } = await initProject();
    const outer = setPickContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      capableTerminal: true,
      prompt: async (request) => ({
        kind: "picked",
        refs: request.rows
          .filter((row) => row.name === "pdf" || row.name === "worker")
          .map(pickRowId),
      }),
    });
    let result: CliResult;
    try {
      result = await runInProcess(project)(
        ["add", url, "--yes", "--json"],
        env,
      );
    } finally {
      setPickContext(outer);
    }
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    const items = objectItems(payload, "items");
    expect(items).toHaveLength(2);
    const pdfRow = items.find((item) => stringField(item, "name") === "pdf")!;
    const workerRow = items.find(
      (item) => stringField(item, "name") === "worker",
    )!;
    expect(pdfRow.plugin).toBeUndefined();
    expect(pdfRow.usesPluginParts).toBeUndefined();
    expect(pdfRow.factsComplete).toBeUndefined();
    expect(stringField(objectField(workerRow, "plugin"), "name")).toBe("heavy");
    expect(arrayField(workerRow, "usesPluginParts")).toHaveLength(3);
    expect(workerRow.factsComplete).toBe(true);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the no-skill hint names both plugin catalog paths",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/empty",
          skills: [],
          files: { "commands/c.md": "# c\n" },
        },
      ],
      { claude: claudeCatalog([{ name: "empty", source: "./plugins/empty" }]) },
    );
    const { project, env } = await initProject();
    const result = await runInProcess(project)(["add", url], env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "capshelf looks for SKILL.md at the repository root and under skills/, .claude/skills/, and .agents/skills/ and in plugins named by .claude-plugin/marketplace.json or .agents/plugins/marketplace.json",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

async function installedHeavySkill() {
  const upstream = await pluginUpstream(threePlugins(), {
    claude: threePluginsCatalog(),
  });
  const { project, env } = await initProject();
  const run = runInProcess(project);
  expect(
    (
      await run(
        [
          "add",
          upstream.url,
          "--path",
          "plugins/heavy/skills/worker",
          "--as",
          "heavy",
          "--yes",
          "--json",
        ],
        env,
      )
    ).exitCode,
  ).toBe(0);
  return { upstream, project, env, run };
}

test(
  "update shows the plugin facts read at the new commit when a remote skill's pin would move",
  async () => {
    const { upstream, project, env, run } = await installedHeavySkill();
    // Not `pushChange`: it rewrites the body to a generic placeholder, which
    // would also erase the facts this test means to see survive the move —
    // the description changes (so the pin moves) and the body, with its
    // plugin-root read, agent reference, and outside link, stays as it was.
    await writeFile(
      join(upstream.work, "plugins/heavy/skills/worker", "SKILL.md"),
      skillText("worker", "Heavy skill, revised", HEAVY_BODY),
    );
    await $`git -C ${upstream.work} add -A`.quiet();
    await $`git -C ${upstream.work} commit -qm "revise the heavy skill description"`.quiet();
    await $`git -C ${upstream.work} push -q origin main`.quiet();
    await run(["status", "--check-upstream", "--json"], env);

    const { context, prompts } = consentContext();
    const result = await runWithConfirmation(
      project,
      env,
      ["update", "skills/heavy"],
      context,
    );
    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "! this skill uses parts of the heavy plugin that are not installed:",
    );
    expect(prompts[0]).toContain("agents         assistant");
    expect(prompts[0]).toContain("outside links  ../../AGENTS.md");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "update never prompts, and reports already-current, when only a file outside the skill directory changed",
  async () => {
    const { upstream, env, run } = await installedHeavySkill();
    // Only the plugin's agent file changes; the skill directory itself, and
    // so its pin digest, stays the same — the rule this prompt must keep.
    await writeFile(
      join(upstream.work, "plugins", "heavy", "agents", "assistant.md"),
      "a different agent\n",
    );
    await $`git -C ${upstream.work} add -A`.quiet();
    await $`git -C ${upstream.work} commit -qm "revise the plugin agent file"`.quiet();
    await $`git -C ${upstream.work} push -q origin main`.quiet();
    await run(["status", "--check-upstream", "--json"], env);

    const result = await run(["update", "skills/heavy", "--json"], env);
    expect(result.exitCode).toBe(0);
    const rows = objectItems(jsonOutput(result), "items");
    expect(rows[0]!.action).toBe("already-current");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
