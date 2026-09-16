import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  candidateAtSubpath,
  discoverRemoteSkills,
  findLicense,
  summarizeCandidate,
} from "../src/remote-discovery";
import { commitAll, tempRepo } from "./cli-fixtures";

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
  expect(found.warnings.join("\n")).toContain(
    ".claude-plugin/marketplace.json",
  );
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
