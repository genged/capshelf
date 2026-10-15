/**
 * `capshelf add <url> --list`, text and JSON, for a repository that publishes
 * Claude/Codex plugins — Task 5 of the plugin-aware remote discovery plan.
 *
 * Fixtures use `pluginUpstream` (`tests/remote-fixtures.ts`), which writes
 * plugin directories with `writePlugins` (`tests/plugin-fixtures.ts`) and
 * commits them to a local bare repository, the same pattern
 * `tests/cli-remote-add.test.ts` uses for its non-plugin cases.
 */
import { expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  arrayField,
  jsonOutput,
  objectItems,
  runInProcess,
  stringField,
} from "./cli-fixtures";
import { claudeCatalog } from "./plugin-fixtures";
import type { PluginSpec } from "./plugin-fixtures";
import {
  initRemoteProject,
  pluginUpstream,
  upstreamWith,
} from "./remote-fixtures";

const initProject = initRemoteProject;

const HEAVY_BODY = `Reads \${CLAUDE_PLUGIN_ROOT}/scripts/x.sh and dispatches heavy:assistant. See [a](../../AGENTS.md) for the shared rules.\n`;

/**
 * `plain` (one skill, no facts), `heavy` (one skill named `worker` that
 * matches `plugin root`, `agents`, and `outside links`), and `empty` (no
 * skill directory, only `commands/`) — the brief's fixture for the grouping,
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

// D2: a capshelf-shaped shelf (a legacy `source: "./"` entry with a `skills`
// array, plus a generated Codex catalog entry under `codex/generated/`) must
// list exactly as it did before this feature. The expected text below is the
// literal output of `bun run src/cli.ts add <url> --list` at `d8b8168` (the
// commit before Task 1), run against this same fixture shape in a scratch
// worktree, with the URL and commit substituted for this run's own values —
// both differ on every run because the fixture repository is created fresh.
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
