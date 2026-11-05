import { expect, spyOn, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as git from "../src/git";
import * as gitMeasure from "../src/git-measure";
import { commitAll, tempRepo } from "./cli-fixtures";

/**
 * `ls` lists the working-tree files of every copy item with one `ls-files`.
 * Each item must get what its own `sourceVisibleFilesUnderPath` gets.
 */

const ITEMS = [
  "skills/a",
  "skills/ab",
  "skills/a b",
  "skills/café",
  "skills/linked",
];

async function workingTree(): Promise<string> {
  const repo = await tempRepo("capshelf-visible-");
  const files = [
    "skills/a/SKILL.md",
    "skills/a/refs/r.md",
    "skills/a/gone.md",
    "skills/ab/SKILL.md",
    "skills/a b/SKILL.md",
    "skills/café/naïve.md",
    "skills/linked/SKILL.md",
    "skills/a/.gitignore",
    ".gitignore",
  ];
  for (const file of files) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), `${file}\n`);
  }
  await writeFile(join(repo, ".gitignore"), "*.log\n");
  await writeFile(join(repo, "skills/a/.gitignore"), "cache/\n");
  await commitAll(repo, "items");
  // Working-tree state after the commit.
  await rm(join(repo, "skills/a/gone.md"));
  await writeFile(join(repo, "skills/a/new.md"), "untracked\n");
  await writeFile(join(repo, "skills/a/debug.log"), "ignored\n");
  await mkdir(join(repo, "skills/a/cache"), { recursive: true });
  await writeFile(join(repo, "skills/a/cache/c.md"), "ignored dir\n");
  await mkdir(join(repo, "skills/ab/deep/er"), { recursive: true });
  await writeFile(join(repo, "skills/ab/deep/er/x.md"), "untracked dir\n");
  await symlink("SKILL.md", join(repo, "skills/linked/link.md"));
  return repo;
}

async function outcome(read: Promise<string[]>): Promise<string[] | string> {
  return await read.catch((error: Error) => `error: ${error.message}`);
}

test("one listing gives each item what its own listing gives", async () => {
  const repo = await workingTree();
  const listFiles = await git.sourceVisibleFilesLister(repo, ITEMS);
  for (const item of [...ITEMS, "skills/not-listed"]) {
    expect({ item, files: await outcome(listFiles(item)) }).toEqual({
      item,
      files: await outcome(git.sourceVisibleFilesUnderPath(repo, item)),
    });
  }
  // The symlink fails its own item only.
  expect(await outcome(listFiles("skills/linked"))).toContain("symlink");
  expect(await outcome(listFiles("skills/a"))).toEqual([
    ".gitignore",
    "SKILL.md",
    "new.md",
    "refs/r.md",
  ]);
});

test("the items share one ls-files process", async () => {
  const repo = await workingTree();
  const reads = spyOn(gitMeasure, "recordGitRead");
  try {
    const listFiles = await git.sourceVisibleFilesLister(repo, ITEMS);
    for (const item of ITEMS) await outcome(listFiles(item));
    expect(reads.mock.calls.filter((call) => call[4]).length).toBe(1);
  } finally {
    reads.mockRestore();
  }
});
