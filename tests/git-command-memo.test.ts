import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../src/git";
import * as gitMeasure from "../src/git-measure";
import { GitReadMemo } from "../src/git-read-memo";
import { captureCommittedItemNeeds, emptyNeeds } from "../src/metadata";
import { pinCurrentSource } from "../src/pin";
import { commitAll, tempRepo } from "./cli-fixtures";

async function skillRepo(prefix: string): Promise<string> {
  const repo = await tempRepo(prefix);
  await mkdir(join(repo, "skills", "alpha"), { recursive: true });
  await writeFile(join(repo, "skills", "alpha", "SKILL.md"), "first\n");
  await commitAll(repo, "alpha v1");
  return repo;
}

/** Count the git processes `run` starts. */
async function gitSpawns(run: () => Promise<void>): Promise<number> {
  const reads = spyOn(gitMeasure, "recordGitRead");
  try {
    await run();
    return reads.mock.calls.filter((call) => call[4]).length;
  } finally {
    reads.mockRestore();
  }
}

test("a walk from a given HEAD ignores later commits and reuses the memo", async () => {
  const repo = await skillRepo("capshelf-head-walk-");
  const firstHead = await git.headSha(repo);
  await writeFile(join(repo, "skills", "alpha", "SKILL.md"), "second\n");
  await commitAll(repo, "alpha v2");
  const secondHead = await git.headSha(repo);
  const memo = new GitReadMemo();

  expect(
    await git.lastTouchingContentCommit(repo, "skills/alpha", {
      head: firstHead,
      memo,
    }),
  ).toBe(firstHead);
  expect(await git.lastTouchingContentCommit(repo, "skills/alpha")).toBe(
    secondHead,
  );
  // A new HEAD is a new key, so a pass that reads HEAD again sees the move.
  expect(
    await git.lastTouchingContentCommit(repo, "skills/alpha", {
      head: secondHead,
      memo,
    }),
  ).toBe(secondHead);

  const walkFromFirstHead = async (withMemo: GitReadMemo) => {
    await git.lastTouchingContentCommit(repo, "skills/alpha", {
      head: firstHead,
      memo: withMemo,
    });
  };
  expect(await gitSpawns(() => walkFromFirstHead(memo))).toBe(0);
  expect(await gitSpawns(() => walkFromFirstHead(new GitReadMemo()))).toBe(1);

  await expect(
    git.lastTouchingCommitForPaths(repo, ["skills/alpha"], { head: "HEAD" }),
  ).rejects.toThrow("needs a full commit id");
});

test("attribute answers are reused within one memo, as copies", async () => {
  const repo = await skillRepo("capshelf-attr-memo-");
  await writeFile(join(repo, ".gitattributes"), "*.md filter=crypt\n");
  await commitAll(repo, "attributes");
  const commit = await git.headSha(repo);
  const paths = ["skills/alpha/SKILL.md"];
  const memo = new GitReadMemo();
  const expected = [
    { path: "skills/alpha/SKILL.md", attribute: "filter", value: "crypt" },
  ];
  const first = await git.checkAttrAtCommit(
    repo,
    commit,
    paths,
    ["filter"],
    undefined,
    memo,
  );
  expect(first).toEqual(expected);
  first[0]!.value = "changed";
  let again: git.CheckAttrResult[] = [];
  const spawns = await gitSpawns(async () => {
    again = await git.checkAttrAtCommit(
      repo,
      commit,
      paths,
      ["filter"],
      undefined,
      memo,
    );
  });
  expect(spawns).toBe(0);
  expect(again).toEqual(expected);
});

test("a pin and its needs reuse the HEAD the caller read", async () => {
  const repo = await skillRepo("capshelf-pin-head-");
  const firstHead = await git.headSha(repo);
  await writeFile(join(repo, "skills", "alpha", "SKILL.md"), "second\n");
  await commitAll(repo, "alpha v2");
  const memo = new GitReadMemo();

  const resolve = spyOn(git, "resolveCommit");
  const head = spyOn(git, "headSha");
  try {
    const pin = await pinCurrentSource(repo, "skills", "alpha", {
      head: firstHead,
      memo,
    });
    expect(pin.sourceCommit).toBe(firstHead);
    const needs = await captureCommittedItemNeeds(
      repo,
      { kind: "skills", name: "alpha" },
      { head: firstHead, memo },
    );
    expect(needs.needsSourceCommit).toBe(firstHead);
    // `log --format=%H` already named the commit, and the caller already read
    // HEAD, so neither is read again.
    expect(resolve).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  } finally {
    resolve.mockRestore();
    head.mockRestore();
  }

  // A second pass at the same HEAD with the same memo starts no git process.
  const secondPass = async () => {
    await pinCurrentSource(repo, "skills", "alpha", { head: firstHead, memo });
    await captureCommittedItemNeeds(
      repo,
      { kind: "skills", name: "alpha" },
      { head: firstHead, memo },
    );
  };
  expect(await gitSpawns(secondPass)).toBe(0);
});

test("committed needs read the sidecar and treat a missing one as empty", async () => {
  const repo = await skillRepo("capshelf-needs-sidecar-");
  const item = { kind: "skills", name: "alpha" } as const;
  const bare = await captureCommittedItemNeeds(repo, item);
  expect(bare.needs).toEqual(emptyNeeds());
  await writeFile(
    join(repo, "skills", "alpha", ".capshelf.yml"),
    "needs:\n  bin: [jq]\n",
  );
  await commitAll(repo, "needs");
  const withSidecar = await captureCommittedItemNeeds(repo, item, {
    memo: new GitReadMemo(),
  });
  expect(withSidecar.needs).not.toEqual(bare.needs);
  expect(JSON.stringify(withSidecar.needs)).toContain("jq");
});
