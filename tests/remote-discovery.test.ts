import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  candidateAtSubpath,
  discoverRemoteSkills,
  findLicense,
  pluginAtSubpath,
  summarizeCandidate,
} from "../src/remote-discovery";
import { commitAll, tempRepo } from "./cli-fixtures";
import { claudeCatalog, writePlugins } from "./plugin-fixtures";
import { skillText } from "./remote-fixtures";

async function skillAt(repo: string, dir: string, description: string) {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(
    join(repo, dir, "SKILL.md"),
    `---\nname: ${dir.split("/").pop()}\ndescription: ${description}\n---\nbody\n`,
  );
}

test("a repository that is one skill has one root candidate", async () => {
  const repo = await tempRepo("capshelf-discovery-root-");
  await skillAt(repo, ".", "Reviews SQL migrations");
  await commitAll(repo, "root skill");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({ subpath: ".", origin: "root" });
  expect(candidates[0]!.description).toBe("Reviews SQL migrations");
});

test("skills/ directories are candidates and the root name is the directory", async () => {
  const repo = await tempRepo("capshelf-discovery-skills-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await skillAt(repo, "skills/xlsx", "Read workbooks");
  await commitAll(repo, "two skills");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual([
    "skills/pdf",
    "skills/xlsx",
  ]);
  expect(candidates.map((c) => c.defaultName)).toEqual(["pdf", "xlsx"]);
});

test("a root skill beside subdirectory skills yields both, never the root alone", async () => {
  const repo = await tempRepo("capshelf-discovery-ambiguous-");
  await skillAt(repo, ".", "Root skill");
  await skillAt(repo, "skills/pdf", "Extract text");
  await commitAll(repo, "ambiguous");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath).sort()).toEqual([".", "skills/pdf"]);
});

test(".claude/skills and .agents/skills are candidates", async () => {
  const repo = await tempRepo("capshelf-discovery-dot-");
  await skillAt(repo, ".claude/skills/one", "One");
  await skillAt(repo, ".agents/skills/two", "Two");
  await commitAll(repo, "dot dirs");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.origin).sort()).toEqual(["agents", "claude"]);
});

test("a nested directory under a skill is content, not a second candidate", async () => {
  const repo = await tempRepo("capshelf-discovery-nested-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await skillAt(repo, "skills/pdf/references", "Not a skill of its own");
  await commitAll(repo, "nested");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual(["skills/pdf"]);
});

test("a marketplace document contributes its skill directories once", async () => {
  const repo = await tempRepo("capshelf-discovery-market-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "example",
      owner: { name: "example" },
      plugins: [
        { name: "pdf", source: "./", strict: false, skills: ["./skills/pdf"] },
      ],
    }),
  );
  await commitAll(repo, "marketplace");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual(["skills/pdf"]);
});

test("a marketplace document names a directory no other rule found", async () => {
  const repo = await tempRepo("capshelf-discovery-market-only-");
  await skillAt(repo, "packages/review", "Reviews migrations");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "example",
      owner: { name: "example" },
      plugins: [
        {
          name: "review",
          source: "https://example.invalid/other",
          skills: ["./packages/review"],
        },
      ],
    }),
  );
  await commitAll(repo, "marketplace only");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual(["packages/review"]);
  expect(candidates[0]).toMatchObject({
    origin: "marketplace",
    defaultName: "review",
  });
});

// D2 "exactly as today": a legacy `skills` entry follows the rules the
// deleted `marketplaceDirectories` used (`src/remote-discovery.ts` at
// `d8b8168`), not D12's unified path rule.
test("a legacy skills entry with a literal /SKILL.md suffix strips only that suffix", async () => {
  const repo = await tempRepo("capshelf-discovery-market-skillmd-");
  await skillAt(repo, "packages/review", "Reviews migrations");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "example",
      owner: { name: "example" },
      plugins: [
        {
          name: "review",
          source: "https://example.invalid/other",
          skills: ["./packages/review/SKILL.md"],
        },
      ],
    }),
  );
  await commitAll(repo, "marketplace skill.md suffix");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual(["packages/review"]);
});

test("a legacy skills entry with no leading ./ is dropped, not resolved", async () => {
  const repo = await tempRepo("capshelf-discovery-market-nodotslash-");
  await skillAt(repo, "packages/review", "Reviews migrations");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "example",
      owner: { name: "example" },
      plugins: [
        {
          name: "review",
          source: "https://example.invalid/other",
          skills: ["packages/review"],
        },
      ],
    }),
  );
  await commitAll(repo, "marketplace no leading dot slash");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates).toEqual([]);
});

test("a directory without SKILL.md is not a candidate", async () => {
  const repo = await tempRepo("capshelf-discovery-empty-");
  await mkdir(join(repo, "skills", "notaskill"), { recursive: true });
  await writeFile(join(repo, "skills", "notaskill", "README.md"), "hi\n");
  await commitAll(repo, "no skill file");
  expect((await discoverRemoteSkills(repo, "HEAD")).candidates).toEqual([]);
});

test("an unsafe directory name is dropped, not installed", async () => {
  const repo = await tempRepo("capshelf-discovery-unsafe-");
  await skillAt(repo, "skills/-dash", "Looks like an option");
  await commitAll(repo, "unsafe name");
  expect((await discoverRemoteSkills(repo, "HEAD")).candidates).toEqual([]);
});

// A10: the document is present and does not parse.
test("a malformed marketplace document warns and never fails discovery", async () => {
  const repo = await tempRepo("capshelf-discovery-bad-market-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    '{"plugins": "not an array"}',
  );
  await commitAll(repo, "bad marketplace");

  const found = await discoverRemoteSkills(repo, "HEAD");
  expect(found.candidates.map((c) => c.subpath)).toEqual(["skills/pdf"]);
  expect(found.warnings.map((w) => w.path)).toContain(
    ".claude-plugin/marketplace.json",
  );
});

test("plugin skill directories become candidates with origin marketplace and plugin facts", async () => {
  const repo = await tempRepo("capshelf-discovery-plugin-");
  await writePlugins(
    repo,
    [
      {
        dir: "plugins/a",
        skills: [
          { name: "one", description: "One" },
          { name: "two", description: "Two" },
        ],
      },
    ],
    { claude: claudeCatalog([{ name: "a", source: "./plugins/a" }]) },
  );
  await commitAll(repo, "plugin a");
  const { candidates, plugins } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates.map((c) => c.subpath)).toEqual([
    "plugins/a/skills/one",
    "plugins/a/skills/two",
  ]);
  for (const candidate of candidates) {
    expect(candidate.origin).toBe("marketplace");
    expect(candidate.plugin?.plugin.name).toBe("a");
  }
  expect(plugins).toHaveLength(1);
});

test("a capshelf-shaped shelf lists as before, with no plugins and no skipped entries", async () => {
  const repo = await tempRepo("capshelf-discovery-shelf-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "example",
      owner: { name: "example" },
      plugins: [
        { name: "pdf", source: "./", strict: false, skills: ["./skills/pdf"] },
      ],
    }),
  );
  await mkdir(join(repo, ".agents", "plugins"), { recursive: true });
  await writeFile(
    join(repo, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      plugins: [
        {
          name: "pdf",
          source: { source: "local", path: "./codex/generated/plugins/pdf" },
        },
      ],
    }),
  );
  await commitAll(repo, "shelf-shaped");
  const found = await discoverRemoteSkills(repo, "HEAD");
  expect(found.candidates.map((c) => c.subpath)).toEqual(["skills/pdf"]);
  expect(found.plugins).toEqual([]);
  expect(found.skipped).toEqual([]);
});

test("an .agents/skills directory that is also a plugin skill keeps its layout origin and gains plugin facts", async () => {
  const repo = await tempRepo("capshelf-discovery-agents-plugin-");
  await writePlugins(
    repo,
    [
      {
        dir: ".agents/skills/x",
        manifestName: "x",
        manifestSkills: "./",
        skills: [],
        files: { "SKILL.md": skillText("x", "Agents dir plugin") },
      },
    ],
    { claude: claudeCatalog([{ name: "x", source: "./.agents/skills/x" }]) },
  );
  await commitAll(repo, "agents plugin");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  const candidate = candidates.find((c) => c.subpath === ".agents/skills/x");
  expect(candidate?.origin).toBe("agents");
  expect(candidate?.plugin?.plugin.name).toBe("x");
});

test("a symlinked skills/x/SKILL.md is not a candidate", async () => {
  const repo = await tempRepo("capshelf-discovery-symlink-skill-");
  await mkdir(join(repo, "skills", "x"), { recursive: true });
  await symlink("../../elsewhere", join(repo, "skills", "x", "SKILL.md"));
  await commitAll(repo, "symlinked skill");
  const { candidates } = await discoverRemoteSkills(repo, "HEAD");
  expect(candidates).toEqual([]);
});

// D14: candidateAtSubpath must apply the same regular-file rule an explicit
// --path takes a route discoverRemoteSkills never does.
test("candidateAtSubpath refuses a symlinked SKILL.md as no SKILL.md", async () => {
  const repo = await tempRepo("capshelf-discovery-candidateatsubpath-symlink-");
  await mkdir(join(repo, "skills", "x"), { recursive: true });
  await symlink("../../elsewhere", join(repo, "skills", "x", "SKILL.md"));
  await commitAll(repo, "symlinked skill");
  await expect(candidateAtSubpath(repo, "HEAD", "skills/x")).rejects.toThrow(
    /no SKILL\.md/,
  );
});

test("pluginAtSubpath finds the plugin at its own directory and nothing at a skill path", async () => {
  const repo = await tempRepo("capshelf-discovery-pluginatsubpath-");
  await writePlugins(
    repo,
    [{ dir: "plugins/a", skills: [{ name: "s", description: "S" }] }],
    { claude: claudeCatalog([{ name: "a", source: "./plugins/a" }]) },
  );
  await commitAll(repo, "plugin a");
  const found = await pluginAtSubpath(repo, "HEAD", "plugins/a");
  expect(found?.plugin.name).toBe("a");
  expect(found?.candidates.map((c) => c.subpath)).toEqual([
    "plugins/a/skills/s",
  ]);
  expect(await pluginAtSubpath(repo, "HEAD", "plugins/a/skills/s")).toBeNull();
});

test("candidateAtSubpath fills plugin facts for a plugin skill directory", async () => {
  const repo = await tempRepo("capshelf-discovery-candidateatsubpath-plugin-");
  await writePlugins(
    repo,
    [{ dir: "plugins/a", skills: [{ name: "s", description: "S" }] }],
    { claude: claudeCatalog([{ name: "a", source: "./plugins/a" }]) },
  );
  await commitAll(repo, "plugin a");
  const candidate = await candidateAtSubpath(
    repo,
    "HEAD",
    "plugins/a/skills/s",
  );
  expect(candidate.plugin?.plugin.name).toBe("a");
});

// D2/D12: the repository root is always legacy. A root manifest must not
// turn `--path .` into a plugin lookup, so a repository whose root is also a
// plugin keeps today's `--path .` behavior.
test('pluginAtSubpath(".") is always null, even with a root manifest', async () => {
  const repo = await tempRepo("capshelf-discovery-root-manifest-");
  await skillAt(repo, ".", "Root skill");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "root-plugin" }),
  );
  await commitAll(repo, "root manifest");
  expect(await pluginAtSubpath(repo, "HEAD", ".")).toBeNull();
});

test('candidateAtSubpath(".") never attaches plugin facts from a root manifest', async () => {
  const repo = await tempRepo("capshelf-discovery-root-manifest-candidate-");
  await skillAt(repo, ".", "Root skill");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "root-plugin" }),
  );
  await commitAll(repo, "root manifest candidate");
  const candidate = await candidateAtSubpath(repo, "HEAD", ".");
  expect(candidate.origin).toBe("root");
  expect(candidate.plugin).toBeUndefined();
});

// The root is never a plugin, so a root manifest gives a layout skill no
// plugin facts. `--path` and the full listing must agree on this.
test("a root manifest gives skills/<x> no plugin facts at --path or in the listing", async () => {
  const repo = await tempRepo("capshelf-discovery-root-manifest-skill-");
  await skillAt(repo, "skills/x", "X");
  await mkdir(join(repo, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(repo, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "root-plugin" }),
  );
  await commitAll(repo, "root manifest with a layout skill");
  const candidate = await candidateAtSubpath(repo, "HEAD", "skills/x");
  expect(candidate.origin).toBe("skills");
  expect(candidate.plugin).toBeUndefined();
  const listed = await discoverRemoteSkills(repo, "HEAD");
  expect(listed.candidates.map((c) => [c.subpath, c.plugin])).toEqual([
    ["skills/x", undefined],
  ]);
});

// The manifest-only fallback for a plugin no catalog
// names at all, exercised through both candidateAtSubpath and pluginAtSubpath.
test("candidateAtSubpath fills manifest-only plugin facts for an uncataloged plugin's skill", async () => {
  const repo = await tempRepo("capshelf-discovery-manifestonly-candidate-");
  await writePlugins(
    repo,
    [
      {
        dir: "tools/p",
        manifestName: "pp",
        skills: [{ name: "s", description: "S" }],
      },
    ],
    {},
  );
  await commitAll(repo, "manifest-only plugin");
  const candidate = await candidateAtSubpath(repo, "HEAD", "tools/p/skills/s");
  expect(candidate.plugin?.plugin.name).toBe("pp");
  expect(candidate.plugin?.plugin.catalogs).toEqual([]);
});

test("pluginAtSubpath finds an uncataloged, manifest-only plugin with its skill", async () => {
  const repo = await tempRepo("capshelf-discovery-manifestonly-pluginat-");
  await writePlugins(
    repo,
    [
      {
        dir: "tools/p",
        manifestName: "pp",
        skills: [{ name: "s", description: "S" }],
      },
    ],
    {},
  );
  await commitAll(repo, "manifest-only plugin");
  const found = await pluginAtSubpath(repo, "HEAD", "tools/p");
  expect(found?.plugin.name).toBe("pp");
  expect(found?.plugin.catalogs).toEqual([]);
  expect(found?.candidates.map((c) => c.subpath)).toEqual(["tools/p/skills/s"]);
});

test("a license inside the item and one at the root are distinguished", async () => {
  const repo = await tempRepo("capshelf-discovery-license-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await writeFile(join(repo, "LICENSE"), "MIT License\n\nCopyright\n");
  await commitAll(repo, "root license");
  const root = await findLicense(repo, "HEAD", "skills/pdf");
  expect(root).toMatchObject({
    path: "LICENSE",
    insideItem: false,
    label: "MIT",
  });

  await writeFile(
    join(repo, "skills", "pdf", "LICENSE.md"),
    "Apache License\n",
  );
  await commitAll(repo, "item license");
  const inside = await findLicense(repo, "HEAD", "skills/pdf");
  expect(inside).toMatchObject({ insideItem: true });
});

test("no license anywhere reports null without throwing", async () => {
  const repo = await tempRepo("capshelf-discovery-nolicense-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await commitAll(repo, "no license");
  expect(await findLicense(repo, "HEAD", "skills/pdf")).toMatchObject({
    path: null,
    label: null,
  });
});

test("an explicit subpath with no SKILL.md names the path it read", async () => {
  const repo = await tempRepo("capshelf-discovery-explicit-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await commitAll(repo, "one skill");
  expect(await candidateAtSubpath(repo, "HEAD", "skills/pdf")).toMatchObject({
    subpath: "skills/pdf",
    defaultName: "pdf",
  });
  await expect(
    candidateAtSubpath(repo, "HEAD", "skills/missing"),
  ).rejects.toThrow(/skills\/missing/);
});

test("the consent summary lists every file with its size", async () => {
  const repo = await tempRepo("capshelf-discovery-summary-");
  await skillAt(repo, "skills/pdf", "Extract text");
  await mkdir(join(repo, "skills", "pdf", "references"), { recursive: true });
  await writeFile(
    join(repo, "skills", "pdf", "references", "tables.md"),
    "tables\n",
  );
  await commitAll(repo, "two files");
  const summary = await summarizeCandidate(repo, "HEAD", "skills/pdf");
  expect(summary.files.map((f) => f.path)).toEqual([
    "SKILL.md",
    "references/tables.md",
  ]);
  expect(summary.totalBytes).toBe(
    summary.files.reduce((sum, f) => sum + f.bytes, 0),
  );
  expect(summary.totalBytes).toBeGreaterThan(0);
});
