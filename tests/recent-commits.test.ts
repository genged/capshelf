import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentCommits } from "../src/git";

async function tempRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-recent-"));
  await $`git -C ${repo} init -q`.quiet();
  await $`git -C ${repo} config user.email dana@acme.test`.quiet();
  await $`git -C ${repo} config user.name Dana`.quiet();
  return repo;
}

async function commit(
  repo: string,
  file: string,
  message: string,
): Promise<void> {
  await writeFile(join(repo, file), `${message}\n`);
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm ${message}`.quiet();
}

describe("recentCommits", () => {
  test("returns commits newest-first with parsed fields", async () => {
    const repo = await tempRepo();
    await commit(repo, "a", "first");
    await commit(repo, "b", "second");
    await commit(repo, "c", "third");

    const commits = await recentCommits(repo);
    expect(commits.map((c) => c.subject)).toEqual(["third", "second", "first"]);
    expect(commits[0]!.author).toBe("Dana");
    expect(commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(commits[0]!.date))).toBe(false);
  });

  test("respects the limit", async () => {
    const repo = await tempRepo();
    await commit(repo, "a", "one");
    await commit(repo, "b", "two");
    await commit(repo, "c", "three");

    expect((await recentCommits(repo, 2)).map((c) => c.subject)).toEqual([
      "three",
      "two",
    ]);
  });

  test("subjects with unit-separator-unsafe characters parse intact", async () => {
    const repo = await tempRepo();
    await commit(repo, "a", "fix: handle a|b and  spacing");
    const [c] = await recentCommits(repo);
    expect(c!.subject).toBe("fix: handle a|b and  spacing");
  });

  test("returns [] for a non-git directory instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capshelf-norepo-"));
    expect(await recentCommits(dir)).toEqual([]);
  });
});
