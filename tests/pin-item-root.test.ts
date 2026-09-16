import { $, file } from "bun";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dataKey } from "../src/lock";
import type { LockEntry } from "../src/lock";
import { gitTreeSource } from "../src/item-source";
import { materializeLockEntry } from "../src/materialize";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "../src/pin";
import { commitAll, tempDir, tempRepo } from "./cli-fixtures";

/**
 * A repository that is itself one skill pins with an item root of `"."`.
 *
 * `literalPathspec(".")` renders `:(literal).`, which selects the whole tree,
 * and `posix.relative(".", "skills/pdf/SKILL.md")` returns the path unchanged,
 * so item-relative names stay unprefixed. Verified against git 2.55.0.
 */
async function rootSkillRepo(): Promise<string> {
  const repo = await tempRepo("capshelf-root-item-", { origin: null });
  await writeFile(
    join(repo, "SKILL.md"),
    "---\nname: sqlreview\ndescription: Reviews SQL\n---\nbody\n",
  );
  await mkdir(join(repo, "references"), { recursive: true });
  await writeFile(join(repo, "references", "locks.md"), "locks\n");
  await commitAll(repo, "root skill");
  return repo;
}

test("an item root of '.' selects the whole tree with unprefixed names", async () => {
  const repo = await rootSkillRepo();
  const commit = (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
  const entries = await itemTreeEntriesAtCommit(
    gitTreeSource({
      repo,
      kind: "skills",
      name: "sql-review",
      commit,
      itemRoot: ".",
    }),
    "skills",
  );
  expect(entries.map((entry) => entry.path)).toEqual([
    "SKILL.md",
    "references/locks.md",
  ]);
  // The repo-relative path is the same here, which is exactly what makes `.`
  // the right whole-tree root: there is no prefix to strip.
  expect(entries.map((entry) => entry.repoRelPath)).toEqual([
    "SKILL.md",
    "references/locks.md",
  ]);
});

test("a root-rooted item materializes under the item's own name", async () => {
  const repo = await rootSkillRepo();
  const project = await tempDir("capshelf-root-item-project-");
  const commit = (await $`git -C ${repo} rev-parse HEAD`.quiet().text()).trim();
  const source = gitTreeSource({
    repo,
    kind: "skills",
    name: "sql-review",
    commit,
    itemRoot: ".",
  });
  const entry: LockEntry = {
    source: "data",
    sourcePinDigest: sourcePinDigest(
      await itemTreeEntriesAtCommit(source, "skills"),
    ),
    sourceCommit: commit,
    appliedAt: new Date().toISOString(),
  };

  const result = await materializeLockEntry({
    project,
    source,
    kind: "skills",
    name: "sql-review",
    key: dataKey("skills", "sql-review"),
    entry,
    scope: "local",
  });

  expect(result.action).toBe("reconciled");
  const installed = join(project, ".agents", "skills", "sql-review");
  expect(await file(join(installed, "SKILL.md")).text()).toContain(
    "name: sqlreview",
  );
  expect(existsSync(join(installed, "references", "locks.md"))).toBe(true);
});
