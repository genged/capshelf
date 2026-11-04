import { afterEach, expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as git from "../src/git";
import * as gitMeasure from "../src/git-measure";
import { GitReadMemo } from "../src/git-read-memo";
import { commitAll, tempRepo } from "./cli-fixtures";

/**
 * A memo answers the tree and attribute reads of items that share a commit
 * from one batched read. These tests compare each answer with a direct Git
 * call on a tree built to confuse a path filter: names that are prefixes of
 * each other, names with spaces and non-ASCII bytes, an executable, a
 * symlink, a gitlink, and nested `.gitattributes` files.
 */

const FILES = [
  "a/x.md",
  "a/sub/y.md",
  "a/sub/deeper/z.txt",
  "ab/x.md",
  "a b/x.md",
  "a.b/x.md",
  "a-/x.md",
  "café/naïve.md",
  "skills/one/SKILL.md",
  "skills/one/.capshelf.yml",
  "skills/one/refs/r.md",
  "skills/one-two/SKILL.md",
  "settings/frag/settings.json",
  "top.md",
  "a/.gitattributes",
];

async function confusingRepo(): Promise<{ repo: string; commit: string }> {
  const repo = await tempRepo("capshelf-batch-reads-");
  for (const file of FILES) {
    await mkdir(join(repo, dirname(file)), { recursive: true });
    await writeFile(join(repo, file), `${file}\n`);
  }
  await writeFile(
    join(repo, ".gitattributes"),
    "*.md filter=crypt\nskills/** diff=skill\n",
  );
  await writeFile(join(repo, "a", ".gitattributes"), "sub/** filter=inner\n");
  await chmod(join(repo, "a", "sub", "y.md"), 0o755);
  await symlink("x.md", join(repo, "ab", "link"));
  await commitAll(repo, "tree");
  // A gitlink entry: a submodule commit in the index, with no submodule.
  const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  await $`git -C ${repo} update-index --add --cacheinfo 160000,${head},a/module`.quiet();
  await $`git -C ${repo} commit -qm gitlink`.quiet();
  return {
    repo,
    commit: (await $`git -C ${repo} rev-parse HEAD`.text()).trim(),
  };
}

/** Deterministic choices, so a failure names a reproducible case. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const CANDIDATES = [
  ...FILES,
  ".gitattributes",
  "ab/link",
  "a/module",
  "a/module/inside",
  "a",
  "a/sub",
  "a/sub/deeper",
  "ab",
  "a b",
  "a.b",
  "a-",
  "café",
  "skills",
  "skills/one",
  "skills/one-two",
  "skills/on",
  "skills/one/refs",
  "settings/frag",
  "settings/frag/settings.json/x",
  "missing",
  "missing/deep.md",
  "top.md/x",
];

function pick(next: () => number, most: number): string[] {
  const count = 1 + Math.floor(next() * most);
  return Array.from(
    { length: count },
    () => CANDIDATES[Math.floor(next() * CANDIDATES.length)]!,
  );
}

function treeReads(
  reads: ReturnType<typeof spyOn<typeof gitMeasure, "recordGitRead">>,
): string[][] {
  return reads.mock.calls
    .filter((call) => call[4] && call[0] === "ls-tree")
    .map((call) => call[2]);
}

afterEach(() => {
  delete process.env.GIT_LITERAL_PATHSPECS;
  delete process.env.GIT_ICASE_PATHSPECS;
});

test("a batched tree read matches Git for every literal pathspec list", async () => {
  const { repo, commit } = await confusingRepo();
  const next = random(7);
  for (let round = 0; round < 40; round++) {
    // A new memo per round, so each round registers a different batch.
    const memo = new GitReadMemo();
    const registered = pick(next, 4);
    git.registerBatchReads(
      memo,
      repo,
      commit,
      registered.map(git.literalPathspec),
    );
    for (let query = 0; query < 4; query++) {
      const paths = pick(next, 3);
      const pathspecs = paths.map(git.literalPathspec);
      const includeTrees = next() < 0.5;
      const direct = await git.lsTreeEntriesForPathspecs(
        repo,
        commit,
        pathspecs,
        { includeTrees },
      );
      const viaMemo = await git.lsTreeEntriesForPathspecs(
        repo,
        commit,
        pathspecs,
        { includeTrees, memo },
      );
      expect({ registered, paths, includeTrees, entries: viaMemo }).toEqual({
        registered,
        paths,
        includeTrees,
        entries: direct,
      });
    }
  }
});

test("a batched attribute query matches Git for any path list", async () => {
  const { repo, commit } = await confusingRepo();
  const next = random(11);
  for (let round = 0; round < 20; round++) {
    const memo = new GitReadMemo();
    const registered = pick(next, 4);
    git.registerBatchReads(
      memo,
      repo,
      commit,
      registered.map(git.literalPathspec),
    );
    for (let query = 0; query < 3; query++) {
      // Duplicates and paths that the commit does not hold are allowed.
      const paths = pick(next, 5);
      const attributes = next() < 0.5 ? ["filter"] : ["filter", "diff"];
      const direct = await git.checkAttrAtCommit(
        repo,
        commit,
        paths,
        attributes,
      );
      const viaMemo = await git.checkAttrAtCommit(
        repo,
        commit,
        paths,
        attributes,
        undefined,
        memo,
      );
      expect({ registered, paths, attributes, results: viaMemo }).toEqual({
        registered,
        paths,
        attributes,
        results: direct,
      });
    }
  }
});

test("items that share a commit share one tree and one attribute read", async () => {
  const { repo, commit } = await confusingRepo();
  const memo = new GitReadMemo();
  const items = ["skills/one", "skills/one-two", "a", "ab", "café"];
  git.registerBatchReads(memo, repo, commit, items.map(git.literalPathspec));
  const reads = spyOn(gitMeasure, "recordGitRead");
  try {
    for (const item of items) {
      const entries = await git.lsTreeEntriesForPathspecs(
        repo,
        commit,
        [git.literalPathspec(item)],
        { memo },
      );
      // Callers ask for the attributes of the files they just listed.
      await git.checkAttrAtCommit(
        repo,
        commit,
        entries
          .filter((entry) => entry.type === "blob")
          .map((entry) => entry.path),
        ["filter"],
        undefined,
        memo,
      );
    }
    const operations = reads.mock.calls
      .filter((call) => call[4])
      .map((call) => call[0]);
    // One batched listing, one objects-dir lookup, one attribute query.
    expect(operations.toSorted()).toEqual(
      ["check-attr", "ls-tree", "rev-parse"].toSorted(),
    );
    // The listing names the registered items, not the whole commit.
    const [listing] = treeReads(reads);
    expect(listing).toContain(":(literal)skills/one");
    expect(listing).not.toContain(":(literal)top.md");
  } finally {
    reads.mockRestore();
  }
});

test("a read outside the registered paths goes to Git alone", async () => {
  const { repo, commit } = await confusingRepo();
  const memo = new GitReadMemo();
  git.registerBatchReads(memo, repo, commit, [git.literalPathspec("a")]);
  const reads = spyOn(gitMeasure, "recordGitRead");
  try {
    await git.lsTreeEntriesForPathspecs(
      repo,
      commit,
      [git.literalPathspec("ab")],
      { memo },
    );
    expect(treeReads(reads)).toEqual([
      ["ls-tree", "-r", "-z", commit, "--", ":(literal)ab"],
    ]);
    expect(memo.batchTrees.size).toBe(0);
  } finally {
    reads.mockRestore();
  }
});

test("a failed batched read keeps the direct error and caches nothing", async () => {
  const { repo } = await confusingRepo();
  const memo = new GitReadMemo();
  const absent = "0".repeat(40);
  git.registerBatchReads(memo, repo, absent, [git.literalPathspec("a")]);
  const read = () =>
    git.lsTreeEntriesForPathspecs(repo, absent, [git.literalPathspec("a")], {
      memo,
    });
  const direct = await git
    .lsTreeEntriesForPathspecs(repo, absent, [git.literalPathspec("a")])
    .then(
      () => "no error",
      (error: Error) => error.message,
    );
  expect(direct).not.toBe("no error");
  expect(await read().catch((error: Error) => error.message)).toBe(direct);
  expect(memo.batchTrees.size).toBe(0);
  expect(memo.trees.size).toBe(0);
});

test("ambient pathspec variables do not change a literal pathspec", async () => {
  const { repo, commit } = await confusingRepo();
  const expected = await git.lsTreeEntriesForPathspecs(repo, commit, [
    git.literalPathspec("a"),
  ]);
  expect(expected.length).toBeGreaterThan(0);
  process.env.GIT_LITERAL_PATHSPECS = "1";
  expect(
    await git.lsTreeEntriesForPathspecs(repo, commit, [
      git.literalPathspec("a"),
    ]),
  ).toEqual(expected);
  delete process.env.GIT_LITERAL_PATHSPECS;
  process.env.GIT_ICASE_PATHSPECS = "1";
  expect(
    await git.lsTreeEntriesForPathspecs(repo, commit, [
      git.literalPathspec("a"),
    ]),
  ).toEqual(expected);
});

async function gitOut(
  repo: string,
  args: string[],
  stdin?: string,
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return out.trim();
}

/**
 * A child of `commit` whose `<item>` tree also holds `../../../x`, built with
 * `git mktree`, which accepts entries named `..`. `ls-tree` then lists
 * `<item>/../../../x`, and `check-attr` refuses that path.
 */
async function withClimbingEntry(
  repo: string,
  commit: string,
  item: string,
): Promise<string> {
  const blob = await gitOut(repo, ["hash-object", "-w", "--stdin"], "up\n");
  let child = await gitOut(repo, ["mktree"], `100644 blob ${blob}\tx\n`);
  for (let level = 0; level < 2; level++) {
    child = await gitOut(repo, ["mktree"], `040000 tree ${child}\t..\n`);
  }
  let childName = "..";
  const parts = item.split("/");
  // Rebuild each tree from the item up to the root with the new child.
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const listing = await gitOut(repo, [
      "ls-tree",
      dir === "" ? commit : `${commit}:${dir}`,
    ]);
    const kept = listing
      .split("\n")
      .filter((line) => line !== "" && !line.endsWith(`\t${childName}`));
    child = await gitOut(
      repo,
      ["mktree"],
      `${[...kept, `040000 tree ${child}\t${childName}`].join("\n")}\n`,
    );
    childName = parts[depth - 1] ?? "";
  }
  return await gitOut(repo, ["commit-tree", child, "-p", commit, "-m", "up"]);
}

async function errorText(read: Promise<unknown>): Promise<string> {
  return await read.then(
    () => "no error",
    (error: Error) => error.message,
  );
}

test("a file that climbs out of one item does not fail another item", async () => {
  const { repo, commit: base } = await confusingRepo();
  const commit = await withClimbingEntry(repo, base, "skills/one-two");
  const climbing = "skills/one-two/../../../x";
  const listed = await git.lsTreeEntriesForPathspecs(repo, commit, [
    git.literalPathspec("skills/one-two"),
  ]);
  expect(listed.map((entry) => entry.path)).toContain(climbing);
  expect(
    await errorText(
      git.checkAttrAtCommit(repo, commit, [climbing], ["filter"]),
    ),
  ).toContain("outside repository");

  const memo = new GitReadMemo();
  git.registerBatchReads(memo, repo, commit, [
    git.literalPathspec("skills/one"),
    git.literalPathspec("skills/one-two"),
  ]);
  const paths = ["skills/one/SKILL.md"];
  expect(
    await git.checkAttrAtCommit(
      repo,
      commit,
      paths,
      ["filter"],
      undefined,
      memo,
    ),
  ).toEqual(await git.checkAttrAtCommit(repo, commit, paths, ["filter"]));
  // The climbing path itself still gets Git's own error.
  expect(
    await errorText(
      git.checkAttrAtCommit(
        repo,
        commit,
        [climbing],
        ["filter"],
        undefined,
        memo,
      ),
    ),
  ).toContain("outside repository");
});

test("registering more paths after a batch read lists them too", async () => {
  const { repo, commit } = await confusingRepo();
  const memo = new GitReadMemo();
  git.registerBatchReads(memo, repo, commit, [git.literalPathspec("a")]);
  await git.lsTreeEntriesForPathspecs(
    repo,
    commit,
    [git.literalPathspec("a")],
    { memo },
  );
  git.registerBatchReads(memo, repo, commit, [git.literalPathspec("ab")]);
  const direct = await git.lsTreeEntriesForPathspecs(repo, commit, [
    git.literalPathspec("ab"),
  ]);
  expect(direct.length).toBeGreaterThan(0);
  expect(
    await git.lsTreeEntriesForPathspecs(
      repo,
      commit,
      [git.literalPathspec("ab")],
      { memo },
    ),
  ).toEqual(direct);
});

test("git show of a committed file prints the blob bytes cat-file reads", async () => {
  const repo = await tempRepo("capshelf-show-bytes-");
  await mkdir(join(repo, "skills", "a"), { recursive: true });
  await writeFile(join(repo, "skills", "a", "SKILL.md"), "lower case text\n");
  await writeFile(
    join(repo, ".gitattributes"),
    "*.md diff=upper filter=upper\n",
  );
  await commitAll(repo, "item");
  // A textconv driver and a smudge filter that would both change the bytes.
  await gitOut(repo, ["config", "diff.upper.textconv", "tr a-z A-Z <"]);
  await gitOut(repo, ["config", "filter.upper.smudge", "tr a-z A-Z"]);
  const commit = await gitOut(repo, ["rev-parse", "HEAD"]);
  const shown = await git.sourceReadBuffer(repo, [
    "show",
    `${commit}:skills/a/SKILL.md`,
  ]);
  const [entry] = await git.lsTreeEntriesForPathspecs(repo, commit, [
    git.literalPathspec("skills/a/SKILL.md"),
  ]);
  const blobs = await git.catFileBlobs(repo, [entry!.object]);
  expect(shown.toString()).toBe("lower case text\n");
  expect(blobs.get(entry!.object)).toEqual(shown);
});
