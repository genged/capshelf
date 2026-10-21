/**
 * `capshelf add <url>` with no `--path`: the picker takes its unit from the
 * repository shape (plugins-on-the-shelf spec D5, the 2026-10-20 reversal).
 *
 * A catalog of plugins that each hold a regular `.claude-plugin/plugin.json`
 * offers plugins. Every other shape offers skills, as before. A repository
 * with both offers one picker with two sections, plugins first.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
  arrayField,
  commitAll,
  jsonOutput,
  objectItems,
  runInProcess,
  stringField,
  tempRepo,
} from "./cli-fixtures";
import type { CliResult } from "./cli-fixtures";
import { claudeCatalog, codexCatalog, writePlugins } from "./plugin-fixtures";
import type { PluginSpec } from "./plugin-fixtures";
import { initRemoteProject, pluginUpstream } from "./remote-fixtures";
import { setDestructiveConfirmationContext } from "../src/destructive-change";
import { setPickContext } from "../src/pick";
import type { PickRequest } from "../src/pick";
import { pickRowId } from "../src/pick-core";
import type { PickRow } from "../src/pick-core";
import { literalPathspec, lsTreeEntriesForPathspecs } from "../src/git";
import { discoverPlugins } from "../src/plugin-discovery";

const ghCli: PluginSpec = {
  dir: "plugins/gh-cli",
  manifestName: "gh-cli",
  manifestDescription: "GitHub CLI helpers",
  skills: [{ name: "gh-cli", description: "Use gh" }],
  files: {
    "agents/worker.md": "---\nname: worker\n---\n",
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "bash hooks/setup.sh" }] },
        ],
      },
    }),
    "hooks/setup.sh": "echo hi\n",
  },
};

const review: PluginSpec = {
  dir: "plugins/review",
  manifestName: "review",
  manifestDescription: "Code review",
  skills: [
    { name: "diff", description: "Read a diff" },
    { name: "style", description: "Check style" },
  ],
};

const docs: PluginSpec = {
  dir: "plugins/docs",
  manifestName: "docs",
  skills: [{ name: "write", description: "Write docs" }],
};

function threeClaudePlugins() {
  return pluginUpstream([ghCli, review, docs], {
    claude: claudeCatalog([
      { name: "gh-cli", source: "./plugins/gh-cli" },
      { name: "review", source: "./plugins/review" },
      { name: "docs", source: "./plugins/docs" },
    ]),
  });
}

/** Two Claude plugins and three skills that no plugin holds. */
function mixedUpstream() {
  return pluginUpstream(
    [
      ghCli,
      review,
      {
        dir: ".",
        skills: [
          { name: "pdf", description: "Extract text" },
          { name: "xlsx", description: "Read workbooks" },
          { name: "docx", description: "Edit documents" },
        ],
      },
    ],
    {
      claude: claudeCatalog([
        { name: "gh-cli", source: "./plugins/gh-cli" },
        { name: "review", source: "./plugins/review" },
      ]),
    },
  );
}

/** Run with a picker that records its request and marks what `pick` keeps. */
async function runWithPicker(
  project: string,
  env: Record<string, string>,
  args: string[],
  pick: (row: PickRow) => boolean,
): Promise<{ result: CliResult; requests: PickRequest[] }> {
  const requests: PickRequest[] = [];
  const outer = setPickContext({
    stdinIsTTY: true,
    stderrIsTTY: true,
    capableTerminal: true,
    prompt: async (request) => {
      requests.push(request);
      return {
        kind: "picked",
        refs: request.rows.filter(pick).map(pickRowId),
      };
    },
  });
  try {
    return { result: await runInProcess(project)(args, env), requests };
  } finally {
    setPickContext(outer);
  }
}

async function remoteKeys(project: string): Promise<string[]> {
  const lock = JSON.parse(
    await readFile(join(project, ".capshelf", "remotes.lock.json"), "utf-8"),
  );
  return Object.keys(lock.items);
}

test(
  "a catalog of Claude plugins with no terminal counts plugins",
  async () => {
    const { url } = await threeClaudePlugins();
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(["add", url], env);
    expect(result.exitCode).toBe(3);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("3 plugins found in ");
    expect(stderr).toContain("; name one with --path");
    expect(stderr).toContain("--list");
    expect(stderr).not.toContain("skills found");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a catalog of Claude plugins offers plugin rows, and a picked plugin installs whole",
  async () => {
    const { url } = await threeClaudePlugins();
    const { project, env } = await initRemoteProject();
    const { result, requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      (row) => row.name === "gh-cli",
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.message).toStartWith("Select plugins to install from ");
    expect(request.rows.map((row) => row.kind)).toEqual([
      "plugins",
      "plugins",
      "plugins",
    ]);
    expect(request.rows.map((row) => row.ref)).toEqual([
      "plugins/gh-cli",
      "plugins/review",
      "plugins/docs",
    ]);
    const gh = request.rows.find((row) => row.name === "gh-cli")!;
    expect(gh.description).toBe("GitHub CLI helpers");
    expect(gh.detail).toBe("plugin: 1 skill, 1 agent · also ships: hooks");
    const reviewRow = request.rows.find((row) => row.name === "review")!;
    expect(reviewRow.detail).toBe("plugin: 2 skills, 0 agents");
    const docsRow = request.rows.find((row) => row.name === "docs")!;
    expect(docsRow.description).toBeUndefined();

    expect(await remoteKeys(project)).toEqual(["remote/plugins/gh-cli"]);
    const dir = join(project, ".agents", "skills", "gh-cli");
    expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "hooks", "hooks.json"))).toBe(true);
    // `--yes` skips the prompt, so what the plugin runs goes to stderr.
    expect(result.stderr.toString()).toContain("bash hooks/setup.sh");
    expect(result.stdout.toString()).toContain(
      "✓ added local/remote/plugins/gh-cli @ ",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a picked plugin with no --yes and no terminal for consent refuses and names its hooks",
  async () => {
    const { url } = await threeClaudePlugins();
    const { project, env } = await initRemoteProject();
    const { result } = await runWithPicker(
      project,
      env,
      ["add", url],
      (row) => row.name === "gh-cli",
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "not installing plugins/gh-cli without consent",
    );
    expect(result.stderr.toString()).toContain("bash hooks/setup.sh");
    expect(existsSync(join(project, ".agents", "skills", "gh-cli"))).toBe(
      false,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "plugins and loose skills share one picker, plugins first, and both install in order",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const { result, requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes", "--json"],
      (row) => row.name === "review" || row.name === "pdf",
    );
    expect(result.exitCode).toBe(0);
    const request = requests[0]!;
    expect(request.message).toStartWith(
      "Select plugins and skills to install from ",
    );
    expect(request.kindOrder).toEqual(["plugins", "skills"]);
    expect(request.rows.map((row) => row.ref)).toEqual([
      "plugins/gh-cli",
      "plugins/review",
      "skills/docx",
      "skills/pdf",
      "skills/xlsx",
    ]);
    // The skills that a plugin holds are part of that plugin's row.
    expect(request.rows.some((row) => row.name === "diff")).toBe(false);

    expect((await remoteKeys(project)).sort()).toEqual([
      "remote/plugins/review",
      "remote/skills/pdf",
    ]);
    const items = objectItems(jsonOutput(result), "items");
    expect(items.map((item) => stringField(item, "kind"))).toEqual([
      "plugins",
      "skills",
    ]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "plugins and loose skills with no terminal count both",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(["add", url], env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "2 plugins and 3 skills found in ",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a picked plugin and a picked skill with the same install name refuse before any write",
  async () => {
    const { url } = await pluginUpstream(
      [
        ghCli,
        review,
        { dir: ".", skills: [{ name: "gh-cli", description: "Loose gh" }] },
      ],
      {
        claude: claudeCatalog([
          { name: "gh-cli", source: "./plugins/gh-cli" },
          { name: "review", source: "./plugins/review" },
        ]),
      },
    );
    const { project, env } = await initRemoteProject();
    const { result } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      (row) => row.name === "gh-cli",
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      '2 selected items would install as "gh-cli": plugins/gh-cli, skills/gh-cli',
    );
    expect(existsSync(join(project, ".capshelf", "remotes.lock.json"))).toBe(
      false,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "catalog plugins with no Claude manifest offer their skills",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/cx",
          skills: [
            { name: "one", description: "One" },
            { name: "two", description: "Two" },
          ],
          files: { ".codex-plugin/plugin.json": '{"name":"cx"}' },
        },
      ],
      { codex: codexCatalog([{ name: "cx", path: "./plugins/cx" }]) },
    );
    const { project, env } = await initRemoteProject();
    const { requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      () => false,
    );
    const request = requests[0]!;
    expect(request.message).toStartWith("Select skills to install from ");
    expect(request.rows.map((row) => row.ref)).toEqual([
      "skills/one",
      "skills/two",
    ]);
    expect(request.kindOrder).toBeUndefined();

    const refused = await runInProcess(project)(["add", url], env);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("2 skills found in ");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a catalog of skill lists offers skills and refuses with the same text as before",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: ".",
          skills: [
            { name: "pdf", description: "Extract text" },
            { name: "xlsx", description: "Read workbooks" },
          ],
        },
      ],
      {
        claude: claudeCatalog([
          {
            name: "shelf",
            source: "./",
            skills: ["./skills/pdf", "./skills/xlsx"],
          },
        ]),
      },
    );
    const { project, env } = await initRemoteProject();
    const refused = await runInProcess(project)(["add", url], env);
    expect(refused.exitCode).toBe(3);
    const stderr = refused.stderr.toString();
    expect(stderr).toMatch(/^✗ 2 skills found in \S+; name one with --path\n/);
    expect(stderr).toContain(`list them: capshelf add ${url} --list`);

    const { requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      () => false,
    );
    expect(requests[0]!.rows.map((row) => row.ref)).toEqual([
      "skills/pdf",
      "skills/xlsx",
    ]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a catalog entry with a skills array for a Claude plugin counts as a plugin",
  async () => {
    const plugins: PluginSpec[] = [
      {
        dir: "plugins/listed",
        manifestName: "listed",
        skills: [
          { name: "a", description: "A" },
          { name: "b", description: "B" },
        ],
      },
      { dir: "plugins/other", manifestName: "other", skills: [] },
    ];
    const catalog = claudeCatalog([
      {
        name: "listed",
        source: "./plugins/listed",
        skills: ["./skills/a", "./skills/b"],
      },
      { name: "other", source: "./plugins/other" },
    ]);

    const repo = await tempRepo("capshelf-plugin-skill-list-");
    await writePlugins(repo, plugins, { claude: catalog });
    await commitAll(repo, "skill list plugin");
    const entries = await lsTreeEntriesForPathspecs(repo, "HEAD", [
      literalPathspec("."),
    ]);
    const inventory = await discoverPlugins(repo, entries);
    expect(inventory.legacySkillDirs).toEqual([]);
    expect(inventory.plugins.map((plugin) => plugin.source)).toEqual([
      "plugins/listed",
      "plugins/other",
    ]);
    expect(inventory.plugins[0]!.skillDirs).toEqual([
      "plugins/listed/skills/a",
      "plugins/listed/skills/b",
    ]);

    const { url } = await pluginUpstream(plugins, { claude: catalog });
    const { project, env } = await initRemoteProject();
    const { requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      () => false,
    );
    expect(requests[0]!.rows.map((row) => row.ref)).toEqual([
      "plugins/listed",
      "plugins/other",
    ]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list prints each plugin with its skills, then the skills that no plugin holds",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.toString().split("\n");
    const gh = lines.indexOf(
      "  plugins/gh-cli   plugin gh-cli: GitHub CLI helpers   also ships: agents, hooks",
    );
    const reviewHeader = lines.indexOf(
      "  plugins/review   plugin review: Code review",
    );
    const pdf = lines.findIndex((line) => line.startsWith("    skills/pdf"));
    expect(gh).toBeGreaterThan(0);
    expect(reviewHeader).toBeGreaterThan(gh);
    expect(lines[reviewHeader + 1]).toStartWith("    diff");
    expect(lines[reviewHeader + 2]).toStartWith("    style");
    expect(pdf).toBeGreaterThan(reviewHeader);
    expect(lines).toContain(
      `  install a whole plugin:  capshelf add ${url} --path plugins/gh-cli`,
    );
    expect(lines).toContain("  Codex sees the skills only.");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--list --json adds the plugin tree fields and keeps every old field",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(
      ["add", url, "--list", "--json"],
      env,
    );
    expect(result.exitCode).toBe(0);
    const payload = jsonOutput(result);
    const plugins = objectItems(payload, "plugins");
    expect(plugins.map((plugin) => Object.keys(plugin))).toEqual([
      [
        "name",
        "source",
        "catalogs",
        "ships",
        "skills",
        "installable",
        "description",
        "skillSubpaths",
      ],
      [
        "name",
        "source",
        "catalogs",
        "ships",
        "skills",
        "installable",
        "description",
        "skillSubpaths",
      ],
    ]);
    expect(plugins[0]).toEqual({
      name: "gh-cli",
      source: "plugins/gh-cli",
      catalogs: ["claude"],
      ships: ["agents", "hooks"],
      skills: 1,
      installable: true,
      description: "GitHub CLI helpers",
      skillSubpaths: ["plugins/gh-cli/skills/gh-cli"],
    });
    const skills = objectItems(payload, "skills");
    expect(skills.map((skill) => stringField(skill, "subpath"))).toContain(
      "skills/pdf",
    );
    expect(arrayField(payload, "skipped")).toEqual([]);
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "the --list footer quotes the real URL and the first plugin path",
  async () => {
    const { url } = await pluginUpstream(
      [{ ...docs, dir: "plugins/my docs" }, ghCli],
      {
        claude: claudeCatalog([
          { name: "docs", source: "./plugins/my docs" },
          { name: "gh-cli", source: "./plugins/gh-cli" },
        ]),
      },
    );
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(["add", url, "--list"], env);
    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain(
      `  install a whole plugin:  capshelf add ${url} --path 'plugins/my docs'\n  Codex sees the skills only.\n`,
    );
    expect(stdout).not.toContain("<url>");
    expect(stdout).not.toContain("<plugin>");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "D9: the question counts the picker's unit",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const prompts: string[] = [];
    const outer = setDestructiveConfirmationContext({
      stdinIsTTY: true,
      stderrIsTTY: true,
      stdoutIsTTY: true,
      terminalRows: 5,
      prompt: async (message) => {
        prompts.push(message);
        return "n";
      },
      stderr: { write: () => {} },
    });
    try {
      const result = await runInProcess(project)(["add", url, "--list"], env);
      expect(result.exitCode).toBe(0);
    } finally {
      setDestructiveConfirmationContext(outer);
    }
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toStartWith("Show all 2 plugins and 3 skills (");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a listing with no plugin that installs whole prints no whole-plugin footer",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/cx",
          skills: [
            { name: "one", description: "One" },
            { name: "two", description: "Two" },
          ],
          files: { ".codex-plugin/plugin.json": '{"name":"cx"}' },
        },
      ],
      { codex: codexCatalog([{ name: "cx", path: "./plugins/cx" }]) },
    );
    const { project, env } = await initRemoteProject();
    const run = runInProcess(project);
    const listed = await run(["add", url, "--list"], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).not.toContain("install a whole plugin");
    expect(listed.stdout.toString()).toContain("  Codex sees the skills only.");

    const scoped = await run(
      ["add", url, "--list", "--path", "plugins/cx"],
      env,
    );
    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout.toString()).not.toContain("install a whole plugin");
    expect(scoped.stdout.toString()).toContain("  Codex sees the skills only.");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a whole plugin with no skill gets a tree header, and the found line counts the picker unit",
  async () => {
    const hooky: PluginSpec = {
      dir: "plugins/hooky",
      manifestName: "hooky",
      manifestDescription: "Hooks only",
      skills: [],
      files: { "commands/c.md": "# c\n" },
    };
    const reviewOne: PluginSpec = {
      dir: "plugins/review",
      manifestName: "review",
      skills: [{ name: "diff", description: "Read a diff" }],
    };
    const { url } = await pluginUpstream([hooky, reviewOne], {
      claude: claudeCatalog([
        { name: "hooky", source: "./plugins/hooky" },
        { name: "review", source: "./plugins/review" },
      ]),
    });
    const { project, env } = await initRemoteProject();
    const run = runInProcess(project);
    const listed = await run(["add", url, "--list"], env);
    expect(listed.exitCode).toBe(0);
    const lines = listed.stdout.toString().split("\n");
    expect(lines).toContain(
      "  plugins/hooky   plugin hooky: Hooks only   also ships: commands",
    );
    expect(lines).toContain("  plugins/review   plugin review");
    expect(lines.some((line) => line.startsWith("  no skills"))).toBe(false);
    expect(lines).toContain(
      "  found     2 plugins  (.claude-plugin/marketplace.json)",
    );

    const refused = await run(["add", url], env);
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr.toString()).toContain("2 plugins found in ");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a whole plugin alone, with no skill, still lists its header",
  async () => {
    const { url } = await pluginUpstream(
      [
        {
          dir: "plugins/hooky",
          manifestName: "hooky",
          skills: [],
          files: { "commands/c.md": "# c\n" },
        },
      ],
      { claude: claudeCatalog([{ name: "hooky", source: "./plugins/hooky" }]) },
    );
    const { project, env } = await initRemoteProject();
    const listed = await runInProcess(project)(["add", url, "--list"], env);
    expect(listed.exitCode).toBe(0);
    const stdout = listed.stdout.toString();
    expect(stdout).toContain("  found     1 plugin  (");
    expect(stdout).toContain("  plugins/hooky   plugin hooky");
    expect(stdout).toContain(
      `  install a whole plugin:  capshelf add ${url} --path plugins/hooky`,
    );
    expect(stdout).not.toContain("install one:");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "plugin rows carry no terminal escape from a manifest name",
  async () => {
    const { url } = await pluginUpstream(
      [{ ...docs, manifestName: "do\u001b[2Jcs" }, review],
      {
        claude: claudeCatalog([
          { name: "docs", source: "./plugins/docs" },
          { name: "review", source: "./plugins/review" },
        ]),
      },
    );
    const { project, env } = await initRemoteProject();
    const { requests } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes"],
      () => false,
    );
    const row = requests[0]!.rows.find((r) => r.ref.includes("[2Jcs"))!;
    expect(row).toBeDefined();
    expect(row.name).not.toContain("\u001b");
    expect(row.ref).not.toContain("\u001b");
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "--as with several picked rows names one item",
  async () => {
    const { url } = await mixedUpstream();
    const { project, env } = await initRemoteProject();
    const { result } = await runWithPicker(
      project,
      env,
      ["add", url, "--yes", "--as", "x"],
      (row) => row.name === "review" || row.name === "pdf",
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "add --as names one item, and 2 were selected",
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);

test(
  "a repository with exactly one whole plugin goes straight to the plugin consent",
  async () => {
    const { url } = await pluginUpstream([ghCli], {
      claude: claudeCatalog([{ name: "gh-cli", source: "./plugins/gh-cli" }]),
    });
    const { project, env } = await initRemoteProject();
    const result = await runInProcess(project)(["add", url], env);
    expect(result.exitCode).toBe(3);
    expect(result.stderr.toString()).toContain(
      "not installing plugins/gh-cli without consent",
    );
    expect(existsSync(join(project, ".agents", "skills", "gh-cli"))).toBe(
      false,
    );
  },
  CLI_INTEGRATION_TEST_TIMEOUT_MS,
);
