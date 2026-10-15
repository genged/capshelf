import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catFileSizes,
  lsTreeEntriesForPathspecs,
  literalPathspec,
} from "../src/git";
import { commitAll, tempRepo } from "./cli-fixtures";

test("catFileSizes returns the byte size of each blob with one process", async () => {
  const repo = await tempRepo("capshelf-sizes-");
  await writeFile(join(repo, "a.txt"), "abc");
  await writeFile(join(repo, "b.txt"), "x".repeat(2048));
  await commitAll(repo, "two files");
  const entries = await lsTreeEntriesForPathspecs(repo, "HEAD", [
    literalPathspec("."),
  ]);
  const ids = entries
    .filter((e) => e.path.endsWith(".txt"))
    .map((e) => e.object);
  const sizes = await catFileSizes(repo, ids);
  expect([...sizes.values()].sort((a, b) => a - b)).toEqual([3, 2048]);
});

test("catFileSizes with no ids runs nothing and returns an empty map", async () => {
  expect((await catFileSizes("/nonexistent", [])).size).toBe(0);
});
