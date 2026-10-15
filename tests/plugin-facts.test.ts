import { expect, test } from "bun:test";
import { literalPathspec, lsTreeEntriesForPathspecs } from "../src/git";
import {
  collectPluginFacts,
  collectPluginFactsWithLimits,
  MAX_FACT_BLOB_BYTES,
  scanSkillFiles,
  workflowMetaName,
} from "../src/plugin-facts";
import { discoverPlugins } from "../src/plugin-discovery";
import { tempRepo, commitAll } from "./cli-fixtures";
import { claudeCatalog, writePlugins } from "./plugin-fixtures";
import { skillText } from "./remote-fixtures";

// ------------------------------------------------------------- scanSkillFiles

test("plugin-root matches CLAUDE_PLUGIN_ROOT and CODEX_PLUGIN_ROOT, not PLUGIN_ROOT alone", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/one",
    pluginName: "p",
    agentNames: [],
    workflowNames: [],
    files: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text "${CLAUDE_PLUGIN_ROOT}" is the fixture, not an interpolation.
      { path: "SKILL.md", text: "reads ${CLAUDE_PLUGIN_ROOT}/x" },
      { path: "scripts/run.sh", text: "echo $CODEX_PLUGIN_ROOT" },
      { path: "notes.md", text: "see PLUGIN_ROOT for details" },
    ],
  });
  expect(uses).toEqual([
    { reason: "plugin-root", refs: ["SKILL.md", "scripts/run.sh"] },
  ]);
});

test("plugin-agents matches p:worker and `worker`, not the bare word worker", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/one",
    pluginName: "p",
    agentNames: ["worker", "helper"],
    workflowNames: [],
    files: [
      { path: "a.md", text: "dispatches subagent_type: p:worker" },
      { path: "b.md", text: "runs the `helper` agent" },
      { path: "c.md", text: "a worker does the job" },
    ],
  });
  expect(uses).toEqual([
    { reason: "plugin-agents", refs: ["helper", "worker"] },
  ]);
});

test("plugin-workflows matches p:build by stem and p:audit by meta name", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/one",
    pluginName: "p",
    agentNames: [],
    workflowNames: ["build", "audit"],
    files: [
      { path: "SKILL.md", text: "run the p:build workflow, then p:audit" },
    ],
  });
  expect(uses).toEqual([
    { reason: "plugin-workflows", refs: ["audit", "build"] },
  ]);
});

test("outside-links matches an escaping link, stays-inside and URL-scheme links do not match", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/one",
    pluginName: "p",
    agentNames: [],
    workflowNames: [],
    files: [
      { path: "SKILL.md", text: "see [x](../../AGENTS.md) for more" },
      {
        path: "ref/a.md",
        text: "see [x](../sibling.md) and [x](https://e.com/../a)",
      },
      {
        path: "nested/b.md",
        text: "see [x](../../CHANGELOG.md#notes 'Title') too",
      },
    ],
  });
  // The ref for nested/b.md's link drops the title but keeps the fragment,
  // trimmed: "../../CHANGELOG.md#notes", not the raw
  // "../../CHANGELOG.md#notes 'Title'".
  expect(uses).toEqual([
    {
      reason: "outside-links",
      refs: ["../../AGENTS.md", "../../CHANGELOG.md#notes"],
    },
  ]);
});

test("a self reference to the skill's own namespaced name does not count", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/p",
    pluginName: "p",
    agentNames: ["p"],
    workflowNames: ["p"],
    files: [
      { path: "SKILL.md", text: "uses p:p for both an agent and a workflow" },
    ],
  });
  expect(uses).toEqual([]);
});

test("scanSkillFiles leaves out a reason with no refs and orders the reasons it keeps", () => {
  const uses = scanSkillFiles({
    skillDir: "plugins/p/skills/one",
    pluginName: "p",
    agentNames: ["worker"],
    workflowNames: [],
    files: [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text "${CLAUDE_PLUGIN_ROOT}" is the fixture, not an interpolation.
      { path: "SKILL.md", text: "p:worker and ${CLAUDE_PLUGIN_ROOT}" },
    ],
  });
  expect(uses).toEqual([
    { reason: "plugin-root", refs: ["SKILL.md"] },
    { reason: "plugin-agents", refs: ["worker"] },
  ]);
});

// ------------------------------------------------------------- workflowMetaName

test("workflowMetaName reads the name in export const meta, name before description", () => {
  const source = `export const meta = { name: "audit", description: "x" };`;
  expect(workflowMetaName(source)).toBe("audit");
});

test("workflowMetaName reads double-quoted names", () => {
  const source = `export const meta = { description: "x", name: "codeql-build" };`;
  expect(workflowMetaName(source)).toBe("codeql-build");
});

test("workflowMetaName reads a multi-line literal", () => {
  const source = [
    "export const meta = {",
    '  description: "zzz",',
    "  name: 'semgrep-scan'",
    "};",
  ].join("\n");
  expect(workflowMetaName(source)).toBe("semgrep-scan");
});

test("workflowMetaName returns null for a file with no meta", () => {
  expect(workflowMetaName("export const foo = 1;\n")).toBeNull();
});

// ------------------------------------------------------------- collectPluginFacts

async function treeEntries(repo: string) {
  return await lsTreeEntriesForPathspecs(repo, "HEAD", [literalPathspec(".")]);
}

test("a NUL blob is skipped and factsComplete stays true", async () => {
  const repo = await tempRepo("capshelf-facts-nul-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/n",
        skills: [
          {
            name: "one",
            description: "One",
            extra: { "binary.dat": "before\0after" },
          },
        ],
      },
    ],
    { claude: claudeCatalog([{ name: "n", source: "./plugins/n" }]) },
  );
  await commitAll(repo, "nul blob");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/n/skills/one")!;
  expect(fact.factsComplete).toBe(true);
  expect(fact.unread).toEqual([]);
});

test("a blob over 1 MB is unread over-1mb and the skill is factsComplete: false", async () => {
  const repo = await tempRepo("capshelf-facts-over1mb-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/o",
        skills: [
          {
            name: "one",
            description: "One",
            extra: { "big.txt": "a".repeat(MAX_FACT_BLOB_BYTES + 1) },
          },
        ],
      },
    ],
    { claude: claudeCatalog([{ name: "o", source: "./plugins/o" }]) },
  );
  await commitAll(repo, "over 1mb");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/o/skills/one")!;
  expect(fact.unread).toEqual([{ path: "big.txt", why: "over-1mb" }]);
  expect(fact.factsComplete).toBe(false);
});

test("collectPluginFactsWithLimits: over-1mb does not inflate the total, and the budget is sticky after the first overflow", async () => {
  const repo = await tempRepo("capshelf-facts-budget-");
  const content = skillText("one", "One");
  const skillSize = Buffer.byteLength(content, "utf8");
  // Sorted order after "SKILL.md": a-big.bin, b-ok.txt, c-overflow.txt, d-tiny.txt.
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/budget",
        skills: [
          {
            name: "one",
            description: "One",
            extra: {
              "a-big.bin": "a".repeat(MAX_FACT_BLOB_BYTES + 1),
              "b-ok.txt": "bbbbb",
              "c-overflow.txt": "c".repeat(20),
              "d-tiny.txt": "d",
            },
          },
        ],
      },
    ],
    { claude: claudeCatalog([{ name: "budget", source: "./plugins/budget" }]) },
  );
  await commitAll(repo, "budget");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  // Budget: SKILL.md (skillSize) + b-ok.txt (5) + 10 bytes of slack. a-big.bin
  // must not count against it (over-1mb), or b-ok.txt would overflow too.
  // c-overflow.txt (20 bytes) genuinely overflows the remaining 10-byte
  // slack. d-tiny.txt (1 byte) would fit against the pre-overflow total on
  // its own, but the budget stays exceeded for every later file.
  const budget = skillSize + 5 + 10;
  const facts = await collectPluginFactsWithLimits(
    repo,
    entries,
    inventory.plugins,
    undefined,
    { maxBlob: MAX_FACT_BLOB_BYTES, budget },
  );
  const fact = facts.get("plugins/budget/skills/one")!;
  expect(fact.unread).toEqual([
    { path: "a-big.bin", why: "over-1mb" },
    { path: "c-overflow.txt", why: "budget" },
    { path: "d-tiny.txt", why: "budget" },
  ]);
  expect(fact.factsComplete).toBe(false);
});

test("filesOutsideSkill counts blobs under the plugin dir outside the one skill", async () => {
  const repo = await tempRepo("capshelf-facts-outside-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/q",
        skills: [{ name: "one", description: "One" }],
        files: { "agents/a.md": "x", "scripts/s.sh": "y" },
      },
    ],
    { claude: claudeCatalog([{ name: "q", source: "./plugins/q" }]) },
  );
  await commitAll(repo, "outside");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/q/skills/one")!;
  expect(fact.filesOutsideSkill).toBe(2);
});

test("an unread workflow file marks every skill of that plugin factsComplete: false, with a relative unread path", async () => {
  const repo = await tempRepo("capshelf-facts-workflow-unread-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/w",
        skills: [
          { name: "one", description: "One" },
          { name: "two", description: "Two" },
        ],
        files: { "workflows/build.js": "a".repeat(MAX_FACT_BLOB_BYTES + 1) },
      },
    ],
    { claude: claudeCatalog([{ name: "w", source: "./plugins/w" }]) },
  );
  await commitAll(repo, "workflow unread");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const one = facts.get("plugins/w/skills/one")!;
  const two = facts.get("plugins/w/skills/two")!;
  expect(one.factsComplete).toBe(false);
  expect(one.unread).toEqual([
    { path: "../../workflows/build.js", why: "over-1mb" },
  ]);
  expect(two.factsComplete).toBe(false);
  expect(two.unread).toEqual([
    { path: "../../workflows/build.js", why: "over-1mb" },
  ]);
});

test("a skill directory that equals its plugin directory does not list an unread workflow blob twice", async () => {
  // A manifest `skills: "./"` makes the plugin directory itself the skill
  // directory, so a workflow file sits under both the skill's own files and
  // the plugin's workflows/ — one blob, and it must be one unread entry.
  const repo = await tempRepo("capshelf-facts-root-skill-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/z",
        manifestName: "z",
        manifestSkills: "./",
        skills: [],
        files: {
          "SKILL.md": skillText("z", "Root skill"),
          "workflows/build.js": "a".repeat(MAX_FACT_BLOB_BYTES + 1),
        },
      },
    ],
    { claude: claudeCatalog([{ name: "z", source: "./plugins/z" }]) },
  );
  await commitAll(repo, "root skill");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  expect(inventory.plugins[0]?.skillDirs).toEqual(["plugins/z"]);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/z")!;
  expect(fact.unread).toEqual([
    { path: "workflows/build.js", why: "over-1mb" },
  ]);
  expect(fact.factsComplete).toBe(false);
});

test("a skill's own plugin-agents and plugin-workflows facts, end to end through collectPluginFacts", async () => {
  const repo = await tempRepo("capshelf-facts-e2e-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/r",
        skills: [
          {
            name: "rev",
            description: "Review",
            body: "dispatches r:worker and runs r:build",
          },
        ],
        files: {
          "agents/worker.md": "an agent\n",
          "workflows/build.js": "export const meta = { name: 'build' };\n",
        },
      },
    ],
    { claude: claudeCatalog([{ name: "r", source: "./plugins/r" }]) },
  );
  await commitAll(repo, "e2e");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/r/skills/rev")!;
  expect(fact.factsComplete).toBe(true);
  expect(fact.usesPluginParts).toEqual([
    { reason: "plugin-agents", refs: ["worker"] },
    { reason: "plugin-workflows", refs: ["build"] },
  ]);
  expect(fact.plugin).toEqual({
    name: "r",
    source: "plugins/r",
    catalogs: ["claude"],
    ships: ["agents", "workflows"],
  });
});

test("a workflow's meta name is used when it differs from the stem", async () => {
  const repo = await tempRepo("capshelf-facts-meta-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/s",
        skills: [
          {
            name: "stat",
            description: "Static analysis",
            body: "runs s:codeql-scan",
          },
        ],
        files: {
          "workflows/semgrep-scan.js":
            "export const meta = { name: 'codeql-scan' };\n",
        },
      },
    ],
    { claude: claudeCatalog([{ name: "s", source: "./plugins/s" }]) },
  );
  await commitAll(repo, "meta name");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/s/skills/stat")!;
  expect(fact.usesPluginParts).toEqual([
    { reason: "plugin-workflows", refs: ["codeql-scan"] },
  ]);
});

test("an agent stem comes only from a .md file; a non-.md file in agents/ gives no plugin-agents fact", async () => {
  const repo = await tempRepo("capshelf-facts-agent-ext-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/u",
        skills: [
          {
            name: "one",
            description: "One",
            body: "mentions `notes.txt` in passing",
          },
        ],
        files: { "agents/notes.txt": "not an agent file" },
      },
    ],
    { claude: claudeCatalog([{ name: "u", source: "./plugins/u" }]) },
  );
  await commitAll(repo, "agent ext");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(repo, entries, inventory.plugins);
  const fact = facts.get("plugins/u/skills/one")!;
  expect(fact.usesPluginParts).toEqual([]);
});

test("onlySkillDirs limits the result to the requested skill directories", async () => {
  const repo = await tempRepo("capshelf-facts-only-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/t",
        skills: [
          { name: "one", description: "One" },
          { name: "two", description: "Two" },
        ],
      },
    ],
    { claude: claudeCatalog([{ name: "t", source: "./plugins/t" }]) },
  );
  await commitAll(repo, "only");
  const entries = await treeEntries(repo);
  const inventory = await discoverPlugins(repo, entries);
  const facts = await collectPluginFacts(
    repo,
    entries,
    inventory.plugins,
    new Set(["plugins/t/skills/one"]),
  );
  expect([...facts.keys()]).toEqual(["plugins/t/skills/one"]);
});
