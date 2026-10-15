import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { literalPathspec, lsTreeEntriesForPathspecs } from "../src/git";
import {
  describePluginDirectory,
  discoverPlugins,
  hasPluginManifest,
  normalizeCatalogPath,
  type PluginInventory,
} from "../src/plugin-discovery";
import { addSkill, commitAll, tempRepo } from "./cli-fixtures";
import { claudeCatalog, codexCatalog, writePlugins } from "./plugin-fixtures";
import { skillText } from "./remote-fixtures";

async function discover(repo: string): Promise<PluginInventory> {
  const entries = await lsTreeEntriesForPathspecs(repo, "HEAD", [
    literalPathspec("."),
  ]);
  return discoverPlugins(repo, "HEAD", entries);
}

test("normalizeCatalogPath strips ./ and a trailing /, and rejects an escape", () => {
  expect(normalizeCatalogPath("./plugins/x/")).toBe("plugins/x");
  expect(normalizeCatalogPath("plugins/x")).toBe("plugins/x");
  expect(normalizeCatalogPath("./")).toBe(".");
  expect(normalizeCatalogPath("./plugins/../x")).toBeNull();
  expect(normalizeCatalogPath("../x")).toBeNull();
  expect(normalizeCatalogPath("/abs")).toBeNull();
});

test("a ./ source lists the plugin directory with its skill dirs", async () => {
  const repo = await tempRepo("capshelf-plugin-dotslash-");
  await writePlugins(
    repo,
    [{ dir: "plugins/a", skills: [{ name: "one", description: "One" }] }],
    { claude: claudeCatalog([{ name: "a", source: "./plugins/a" }]) },
  );
  await commitAll(repo, "plugin a");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([
    {
      name: "a",
      source: "plugins/a",
      catalogs: ["claude"],
      ships: [],
      skillDirs: ["plugins/a/skills/one"],
    },
  ]);
});

test("a bare name resolves via metadata.pluginRoot, or from the root without it", async () => {
  const withRoot = await tempRepo("capshelf-plugin-bare-root-");
  await writePlugins(
    withRoot,
    [{ dir: "plugins/b", skills: [{ name: "one", description: "One" }] }],
    {
      claude: claudeCatalog([{ name: "b", source: "b" }], {
        pluginRoot: "./plugins",
      }),
    },
  );
  await commitAll(withRoot, "bare with root");
  const withRootInventory = await discover(withRoot);
  expect(withRootInventory.plugins.map((p) => p.source)).toEqual(["plugins/b"]);

  const noRoot = await tempRepo("capshelf-plugin-bare-noroot-");
  await writePlugins(
    noRoot,
    [{ dir: "c", skills: [{ name: "two", description: "Two" }] }],
    {
      claude: claudeCatalog([{ name: "c", source: "c" }]),
    },
  );
  await commitAll(noRoot, "bare without root");
  const noRootInventory = await discover(noRoot);
  expect(noRootInventory.plugins.map((p) => p.source)).toEqual(["c"]);
});

test("an object source is skipped as external-source", async () => {
  const repo = await tempRepo("capshelf-plugin-external-");
  await writePlugins(repo, [], {
    claude: claudeCatalog([
      { name: "ext", source: { source: "github", repo: "x/y" } },
    ]),
  });
  await commitAll(repo, "external");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([]);
  expect(inventory.skipped).toEqual([
    {
      name: "ext",
      catalog: "claude",
      reason: "external-source",
      sourceKind: "github",
    },
  ]);
});

test("a ./ source with a skills array is legacy: no plugin, dirs in legacySkillDirs", async () => {
  const repo = await tempRepo("capshelf-plugin-legacy-");
  await addSkill(repo, "pdf");
  await writePlugins(repo, [], {
    claude: claudeCatalog([
      { name: "pdf", source: "./", skills: ["./skills/pdf"] },
    ]),
  });
  await commitAll(repo, "legacy");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([]);
  expect(inventory.legacySkillDirs).toEqual(["skills/pdf"]);
});

test("an unsafe source is skipped as unsafe-path", async () => {
  const repo = await tempRepo("capshelf-plugin-unsafe-");
  await writePlugins(repo, [], {
    claude: claudeCatalog([{ name: "bad", source: "./a/../b" }]),
  });
  await commitAll(repo, "unsafe");
  const inventory = await discover(repo);
  expect(inventory.skipped).toEqual([
    {
      name: "bad",
      catalog: "claude",
      reason: "unsafe-path",
      source: "./a/../b",
    },
  ]);
});

test("a missing directory is skipped as missing", async () => {
  const repo = await tempRepo("capshelf-plugin-missing-");
  await writePlugins(repo, [], {
    claude: claudeCatalog([{ name: "gone", source: "./plugins/gone" }]),
  });
  await commitAll(repo, "missing");
  const inventory = await discover(repo);
  expect(inventory.skipped).toEqual([
    {
      name: "gone",
      catalog: "claude",
      reason: "missing",
      source: "./plugins/gone",
    },
  ]);
});

test("a symlinked catalog warns once and lists no plugins", async () => {
  const repo = await tempRepo("capshelf-plugin-symlink-catalog-");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await symlink("nowhere", join(repo, ".claude-plugin", "marketplace.json"));
  await commitAll(repo, "symlinked catalog");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([]);
  expect(inventory.warnings).toEqual([
    {
      path: ".claude-plugin/marketplace.json",
      message: "is a symlink or submodule, not a file; ignored",
    },
  ]);
});

test("a symlinked SKILL.md is not a skill directory", async () => {
  const repo = await tempRepo("capshelf-plugin-symlink-skill-");
  await mkdir(join(repo, "plugins", "a", "skills", "one"), { recursive: true });
  await symlink(
    "../../../elsewhere",
    join(repo, "plugins", "a", "skills", "one", "SKILL.md"),
  );
  await writePlugins(repo, [], {
    claude: claudeCatalog([{ name: "a", source: "./plugins/a" }]),
  });
  await commitAll(repo, "symlinked skill");
  const inventory = await discover(repo);
  expect(inventory.plugins).toHaveLength(1);
  expect(inventory.plugins[0]?.skillDirs).toEqual([]);
});

test("a Codex-only entry lists the plugin with catalogs: [codex]", async () => {
  const repo = await tempRepo("capshelf-plugin-codex-only-");
  await writePlugins(
    repo,
    [{ dir: "plugins/c", skills: [{ name: "one", description: "One" }] }],
    { codex: codexCatalog([{ name: "c", path: "./plugins/c" }]) },
  );
  await commitAll(repo, "codex only");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([
    {
      name: "c",
      source: "plugins/c",
      catalogs: ["codex"],
      ships: [],
      skillDirs: ["plugins/c/skills/one"],
    },
  ]);
});

test("both catalogs naming one directory merge to one plugin", async () => {
  const repo = await tempRepo("capshelf-plugin-merge-");
  await writePlugins(
    repo,
    [{ dir: "plugins/m", skills: [{ name: "one", description: "One" }] }],
    {
      claude: claudeCatalog([{ name: "m", source: "./plugins/m" }]),
      codex: codexCatalog([{ name: "m", path: "./plugins/m" }]),
    },
  );
  await commitAll(repo, "merged");
  const inventory = await discover(repo);
  expect(inventory.plugins).toHaveLength(1);
  expect(inventory.plugins[0]?.catalogs).toEqual(["claude", "codex"]);
});

test("a Codex path under codex/generated is dropped and is not in skipped", async () => {
  const repo = await tempRepo("capshelf-plugin-generated-");
  await writePlugins(
    repo,
    [
      {
        dir: "codex/generated/plugins/x",
        skills: [{ name: "one", description: "One" }],
      },
    ],
    {
      codex: codexCatalog([{ name: "x", path: "./codex/generated/plugins/x" }]),
    },
  );
  await commitAll(repo, "generated");
  const inventory = await discover(repo);
  expect(inventory.plugins).toEqual([]);
  expect(inventory.skipped).toEqual([]);
});

test("a Codex url source is external-source with sourceKind url", async () => {
  const repo = await tempRepo("capshelf-plugin-codex-url-");
  await writePlugins(repo, [], {
    codex: codexCatalog([
      {
        name: "u",
        source: { source: "url", url: "https://example.invalid/x" },
      },
    ]),
  });
  await commitAll(repo, "codex url");
  const inventory = await discover(repo);
  expect(inventory.skipped).toEqual([
    {
      name: "u",
      catalog: "codex",
      reason: "external-source",
      sourceKind: "url",
    },
  ]);
});

test("a manifest skills field adds extra children, and a direct skill itself", async () => {
  const repo = await tempRepo("capshelf-plugin-manifest-skills-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/e",
        manifestName: "e",
        manifestSkills: "./extra/",
        skills: [{ name: "defskill", description: "Def" }],
        files: { "extra/xskill/SKILL.md": skillText("xskill", "Extra skill") },
      },
      {
        dir: "plugins/f",
        manifestName: "f",
        manifestSkills: ["./one"],
        skills: [],
        files: { "one/SKILL.md": skillText("one", "Manifest-only skill") },
      },
    ],
    {
      claude: claudeCatalog([
        { name: "e", source: "./plugins/e" },
        { name: "f", source: "./plugins/f" },
      ]),
    },
  );
  await commitAll(repo, "manifest extras");
  const inventory = await discover(repo);
  const e = inventory.plugins.find((p) => p.source === "plugins/e");
  const f = inventory.plugins.find((p) => p.source === "plugins/f");
  expect(e?.skillDirs).toEqual([
    "plugins/e/extra/xskill",
    "plugins/e/skills/defskill",
  ]);
  expect(f?.skillDirs).toEqual(["plugins/f/one"]);
});

test("a manifest skills path that leaves the plugin warns and adds nothing", async () => {
  const repo = await tempRepo("capshelf-plugin-manifest-escape-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/g",
        manifestName: "g",
        manifestSkills: "./../other/skills",
        skills: [{ name: "one", description: "One" }],
      },
    ],
    { claude: claudeCatalog([{ name: "g", source: "./plugins/g" }]) },
  );
  await commitAll(repo, "manifest escape");
  const inventory = await discover(repo);
  const plugin = inventory.plugins.find((p) => p.source === "plugins/g");
  expect(plugin?.skillDirs).toEqual(["plugins/g/skills/one"]);
  expect(inventory.warnings).toEqual([
    {
      path: "plugins/g/.claude-plugin/plugin.json",
      message: "skills path ./../other/skills leaves the plugin; skipped",
    },
  ]);
});

test("the plugin name comes from the manifest, then the catalog, then the directory, warning once on disagreement", async () => {
  const repo = await tempRepo("capshelf-plugin-name-order-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/h",
        manifestName: "from-manifest",
        skills: [{ name: "one", description: "One" }],
      },
      { dir: "plugins/i", skills: [{ name: "two", description: "Two" }] },
    ],
    {
      claude: claudeCatalog([
        { name: "from-catalog", source: "./plugins/h" },
        { name: "beta", source: "./plugins/i" },
      ]),
    },
  );
  await commitAll(repo, "name order");
  const inventory = await discover(repo);
  const h = inventory.plugins.find((p) => p.source === "plugins/h");
  const i = inventory.plugins.find((p) => p.source === "plugins/i");
  expect(h?.name).toBe("from-manifest");
  expect(i?.name).toBe("beta");
  expect(inventory.warnings).toEqual([
    {
      path: "plugins/h",
      message:
        "catalogs and manifests name it from-catalog, h; shown as from-manifest",
    },
    {
      path: "plugins/i",
      message: "catalogs and manifests name it i; shown as beta",
    },
  ]);
});

test("a nested plugin directory is skipped, and its skills are not the outer plugin's", async () => {
  const repo = await tempRepo("capshelf-plugin-nested-");
  await writePlugins(
    repo,
    [
      { dir: "plugins/a", skills: [{ name: "one", description: "One" }] },
      { dir: "plugins/a/inner", skills: [{ name: "y", description: "Y" }] },
    ],
    {
      claude: claudeCatalog([
        { name: "a", source: "./plugins/a" },
        { name: "inner", source: "./plugins/a/inner" },
      ]),
    },
  );
  await commitAll(repo, "nested");
  const inventory = await discover(repo);
  expect(inventory.plugins).toHaveLength(1);
  expect(inventory.plugins[0]).toMatchObject({
    source: "plugins/a",
    skillDirs: ["plugins/a/skills/one"],
  });
  expect(inventory.skipped).toEqual([
    {
      name: "inner",
      catalog: "claude",
      reason: "nested-plugin",
      source: "plugins/a/inner",
    },
  ]);
});

test("ships lists agents, hooks, and .mcp.json in PLUGIN_PARTS order", async () => {
  const repo = await tempRepo("capshelf-plugin-ships-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/j",
        skills: [{ name: "one", description: "One" }],
        files: {
          "hooks/pre-commit.sh": "#!/bin/sh\n",
          "agents/worker.md": "worker\n",
          ".mcp.json": "{}\n",
        },
      },
    ],
    { claude: claudeCatalog([{ name: "j", source: "./plugins/j" }]) },
  );
  await commitAll(repo, "ships");
  const inventory = await discover(repo);
  expect(inventory.plugins[0]?.ships).toEqual(["agents", "hooks", ".mcp.json"]);
});

test("plugins keep catalog order, Claude first then Codex-only", async () => {
  const repo = await tempRepo("capshelf-plugin-order-");
  await writePlugins(
    repo,
    [
      { dir: "plugins/k1", skills: [{ name: "one", description: "One" }] },
      { dir: "plugins/k2", skills: [{ name: "two", description: "Two" }] },
      { dir: "plugins/k3", skills: [{ name: "three", description: "Three" }] },
    ],
    {
      claude: claudeCatalog([
        { name: "k2", source: "./plugins/k2" },
        { name: "k1", source: "./plugins/k1" },
      ]),
      codex: codexCatalog([{ name: "k3", path: "./plugins/k3" }]),
    },
  );
  await commitAll(repo, "order");
  const inventory = await discover(repo);
  expect(inventory.plugins.map((p) => p.source)).toEqual([
    "plugins/k2",
    "plugins/k1",
    "plugins/k3",
  ]);
});

test("a Claude catalog that does not parse warns, and the Codex catalog still lists its plugins", async () => {
  const repo = await tempRepo("capshelf-plugin-bad-claude-");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    '{"plugins": "not an array"}',
  );
  await writePlugins(
    repo,
    [{ dir: "plugins/l", skills: [{ name: "one", description: "One" }] }],
    { codex: codexCatalog([{ name: "l", path: "./plugins/l" }]) },
  );
  await commitAll(repo, "bad claude catalog");
  const inventory = await discover(repo);
  expect(inventory.plugins.map((p) => p.source)).toEqual(["plugins/l"]);
  expect(inventory.warnings).toHaveLength(1);
  expect(inventory.warnings[0]?.path).toBe(".claude-plugin/marketplace.json");
  expect(inventory.warnings[0]?.message).toContain(
    "is present and could not be read:",
  );
});

test("hasPluginManifest and describePluginDirectory work for a directory no catalog names (Ruling A)", async () => {
  const repo = await tempRepo("capshelf-plugin-manifest-only-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/n",
        manifestName: "n",
        skills: [{ name: "one", description: "One" }],
      },
    ],
    {},
  );
  await commitAll(repo, "manifest only");
  const entries = await lsTreeEntriesForPathspecs(repo, "HEAD", [
    literalPathspec("."),
  ]);
  expect(hasPluginManifest(entries, "plugins/n")).toBe(true);
  expect(hasPluginManifest(entries, "plugins/does-not-exist")).toBe(false);

  const { plugin, warnings } = await describePluginDirectory(
    repo,
    entries,
    "plugins/n",
    {},
    [],
  );
  expect(plugin).toEqual({
    name: "n",
    source: "plugins/n",
    catalogs: [],
    ships: [],
    skillDirs: ["plugins/n/skills/one"],
  });
  expect(warnings).toEqual([]);
});
