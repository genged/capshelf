import { expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../src/git";
import { GitReadMemo, gitObjectReadKey } from "../src/git-read-memo";
import { commitAll, tempRepo } from "./cli-fixtures";

test("immutable reads reuse successes, isolate repositories, and leave refs live", async () => {
  const repo = await tempRepo("capshelf-memo-");
  const other = await tempRepo("capshelf-memo-other-");
  const read = spyOn(git, "sourceRead");
  try {
    await writeFile(join(repo, "one"), "first");
    await commitAll(repo, "first");
    const commit = await git.headSha(repo);
    const memo = new GitReadMemo();
    expect(await git.commitExists(repo, commit, memo)).toBe(true);
    read.mockClear();
    expect(await git.commitExists(repo, commit, memo)).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(await git.commitExists(other, commit, memo)).toBe(false);
    await git.showAtCommit(repo, commit, "one", memo);
    const bytes = await git.showAtCommit(repo, commit, "one", memo);
    bytes.fill(0);
    expect((await git.showAtCommit(repo, commit, "one", memo)).toString()).toBe(
      "first",
    );
    expect((await git.showAtCommit(repo, "HEAD", "one", memo)).toString()).toBe(
      "first",
    );
    await writeFile(join(repo, "one"), "second");
    await commitAll(repo, "second");
    expect((await git.showAtCommit(repo, "HEAD", "one", memo)).toString()).toBe(
      "second",
    );
    const paths = [git.literalPathspec("one")];
    const entries = await git.lsTreeEntriesForPathspecs(repo, commit, paths, {
      memo,
    });
    entries[0]!.path = "changed";
    read.mockClear();
    expect(
      (await git.lsTreeEntriesForPathspecs(repo, commit, paths, { memo }))[0]!
        .path,
    ).toBe("one");
    expect(read).not.toHaveBeenCalled();
    expect(
      await git.lsTreeEntriesForPathspecs(
        repo,
        commit,
        [git.literalPathspec("absent")],
        { memo },
      ),
    ).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    await git.commitExists(repo, commit, new GitReadMemo());
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    read.mockRestore();
    await rm(repo, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
}, 30000);

test("batch memo filters cached IDs and retries a missing object after repair", async () => {
  const repo = await tempRepo("capshelf-memo-batch-");
  try {
    await writeFile(join(repo, "one"), "first");
    await writeFile(join(repo, "two"), "second");
    await commitAll(repo, "two blobs");
    const commit = await git.headSha(repo);
    const entries = await git.lsTreeEntriesForPathspecs(repo, commit, [
      git.literalPathspec("one"),
      git.literalPathspec("two"),
    ]);
    const first = entries[0]!.object;
    const second = entries[1]!.object;
    const memo = new GitReadMemo();
    const read = spyOn(git, "sourceRead");
    try {
      await git.catFileBlobs(repo, [first, first], memo);
      read.mockClear();
      expect(
        (await git.catFileBlobs(repo, [first], memo)).get(first)?.toString(),
      ).toBe("first");
      expect(read).not.toHaveBeenCalled();
      const path = join(
        repo,
        ".git",
        "objects",
        second.slice(0, 2),
        second.slice(2),
      );
      const object = await readFile(path);
      await rm(path);
      await expect(
        git.catFileBlobs(repo, [first, second], memo),
      ).rejects.toThrow(second);
      expect(read.mock.calls[0]?.[2]?.stdin).toBe(`${second}\n`);
      await writeFile(path, object);
      expect(
        (await git.catFileBlobs(repo, [first, second], memo))
          .get(second)
          ?.toString(),
      ).toBe("second");
      expect(read).toHaveBeenCalledTimes(2);
      read.mockClear();
      await git.catFileBlobs(repo, [first, second, second], memo);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}, 30000);

test("memo keys accept only full SHA-1 and SHA-256 object names", () => {
  for (const width of [40, 64])
    expect(gitObjectReadKey("repo", "a".repeat(width))).toBeDefined();
  for (const ref of [
    "HEAD",
    "main",
    "abc123",
    "a".repeat(41),
    "a".repeat(63),
    "z".repeat(40),
  ])
    expect(gitObjectReadKey("repo", ref)).toBeUndefined();
  expect(gitObjectReadKey("one", "a".repeat(40))).not.toBe(
    gitObjectReadKey("two", "a".repeat(40)),
  );
});
