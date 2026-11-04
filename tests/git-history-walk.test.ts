import { expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as git from "../src/git";
import * as gitMeasure from "../src/git-measure";
import { GitReadMemo } from "../src/git-read-memo";
import { tempRepo } from "./cli-fixtures";

/**
 * One history walk answers `log -1 <head> -- <pathspecs>` for many items.
 * These tests compare each answer with the item's own `log -1` on random
 * linear histories, from several heads.
 */

const COPY_ITEMS = ["skills/a", "skills/ab", "skills/a-b", "skills/café"];
const FILE_ITEMS = [
  ["subagents/s/claude.md", "subagents/s/codex.toml"],
  ["subagents/t/claude.md", "subagents/t/codex.toml"],
];
const FILES = [
  ...COPY_ITEMS.flatMap((item) => [
    `${item}/SKILL.md`,
    `${item}/refs/r.md`,
    `${item}/.capshelf.yml`,
  ]),
  ...FILE_ITEMS.flat(),
  "subagents/s/other.md",
  "settings/f/settings.json",
  "docs/readme.md",
];

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

async function exists(repo: string, path: string): Promise<boolean> {
  return (
    (
      await $`git -C ${repo} ls-files --error-unmatch -- ${path}`
        .nothrow()
        .quiet()
    ).exitCode === 0
  );
}

/** One random change, staged. Some changes touch only a sidecar. */
async function change(repo: string, next: () => number, round: number) {
  const path = FILES[Math.floor(next() * FILES.length)]!;
  const full = join(repo, path);
  const roll = next();
  if (roll < 0.45 || !(await exists(repo, path))) {
    await mkdir(dirname(full), { recursive: true });
    await rm(full, { force: true });
    await writeFile(full, `${path} ${round}\n`);
  } else if (roll < 0.6) {
    await $`git -C ${repo} rm -qf -- ${path}`.quiet();
    return;
  } else if (roll < 0.72) {
    // A symlink has no mode of its own to change, so it becomes a file.
    await chmod(full, round % 2 === 0 ? 0o755 : 0o644).catch(async () => {
      await rm(full, { force: true });
      await writeFile(full, `${path} ${round}\n`);
    });
  } else if (roll < 0.84) {
    const target = FILES[Math.floor(next() * FILES.length)]!;
    if (target !== path && !(await exists(repo, target))) {
      await mkdir(dirname(join(repo, target)), { recursive: true });
      await rm(join(repo, target), { force: true, recursive: true });
      await $`git -C ${repo} mv -- ${path} ${target}`.quiet();
      return;
    }
  } else {
    await rm(full, { force: true });
    await symlink("elsewhere", full);
  }
  await $`git -C ${repo} add -A -- ${path}`.quiet();
}

async function randomHistory(
  seed: number,
): Promise<{ repo: string; heads: string[] }> {
  const repo = await tempRepo(`capshelf-walk-${seed}-`);
  const next = random(seed);
  const heads: string[] = [];
  for (let round = 0; round < 25; round++) {
    const count = Math.floor(next() * 3);
    for (let i = 0; i < count; i++) await change(repo, next, round);
    await $`git -C ${repo} commit -q --allow-empty -m ${`round ${round}`}`.quiet();
    heads.push((await $`git -C ${repo} rev-parse HEAD`.text()).trim());
  }
  return { repo, heads };
}

function pathspecLists(): string[][] {
  return [
    ...COPY_ITEMS.map((item) => git.contentCommitPathspecs(item)),
    ...FILE_ITEMS.map((paths) => paths.map(git.literalPathspec)),
    ["settings/f/settings.json"].map(git.literalPathspec),
    // Lists with no commit that touches them.
    git.contentCommitPathspecs("skills/never"),
    ["subagents/none/claude.md", "subagents/none/codex.toml"].map(
      git.literalPathspec,
    ),
  ];
}

async function direct(repo: string, head: string, pathspecs: string[]) {
  const out =
    await $`git -C ${repo} --no-replace-objects log -1 --format=%H ${head} -- ${pathspecs}`.text();
  return out.trim() || null;
}

test("one walk selects the same commit as each item's own log -1", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { repo, heads } = await randomHistory(seed);
    for (const head of [heads[24]!, heads[17]!, heads[9]!]) {
      const memo = new GitReadMemo();
      const lists = pathspecLists();
      await git.prefetchLastTouchingCommits(repo, head, lists, memo);
      for (const pathspecs of lists) {
        const key = JSON.stringify([repo, head, pathspecs]);
        const expected = await direct(repo, head, pathspecs);
        if (pathspecs.length < 2) {
          // `log.follow` applies to one path, so the walk leaves it alone.
          expect(memo.lastTouching.has(key)).toBe(false);
          continue;
        }
        expect({
          seed,
          head,
          pathspecs,
          answer: memo.lastTouching.get(key),
        }).toEqual({
          seed,
          head,
          pathspecs,
          answer: expected,
        });
      }
    }
  }
}, 60_000);

test("callers read the walked answers with no Git process", async () => {
  const { repo, heads } = await randomHistory(9);
  const head = heads[24]!;
  const memo = new GitReadMemo();
  await git.prefetchLastTouchingCommits(repo, head, pathspecLists(), memo);
  const reads = spyOn(gitMeasure, "recordGitRead");
  try {
    for (const item of COPY_ITEMS) {
      await git
        .lastTouchingContentCommit(repo, item, { head, memo })
        .catch(() => undefined);
    }
    const spawned = reads.mock.calls.filter((call) => call[4]);
    // Only an item that the history never touched outside its sidecar falls
    // back to its own unfiltered walk.
    for (const call of spawned) {
      expect(call[2]).not.toContain(":(literal,exclude)skills/a/.capshelf.yml");
    }
  } finally {
    reads.mockRestore();
  }
});

test("a file moved out of an item changes that item", async () => {
  const repo = await tempRepo("capshelf-walk-move-");
  for (const file of [
    "skills/a/SKILL.md",
    "skills/a/refs/r.md",
    "skills/ab/SKILL.md",
  ]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(
      join(repo, file),
      `${file}\nwith enough shared text to look alike\n`,
    );
  }
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm add`.quiet();
  await $`git -C ${repo} mv skills/a/refs/r.md skills/ab/r.md`.quiet();
  await $`git -C ${repo} commit -qm move`.quiet();
  const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  const memo = new GitReadMemo();
  const lists = [
    git.contentCommitPathspecs("skills/a"),
    git.contentCommitPathspecs("skills/ab"),
  ];
  await git.prefetchLastTouchingCommits(repo, head, lists, memo);
  for (const pathspecs of lists) {
    expect(memo.lastTouching.get(JSON.stringify([repo, head, pathspecs]))).toBe(
      head,
    );
  }
});

test("a history with a merge commit is not walked", async () => {
  const { repo } = await randomHistory(11);
  await $`git -C ${repo} checkout -q -b side HEAD~3`.quiet();
  await mkdir(join(repo, "skills", "ab"), { recursive: true });
  await writeFile(join(repo, "skills", "ab", "side.md"), "side\n");
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm side`.quiet();
  const branch = (
    await $`git -C ${repo} rev-parse --abbrev-ref @{-1}`.text()
  ).trim();
  await $`git -C ${repo} checkout -q ${branch}`.quiet();
  await $`git -C ${repo} merge -q --no-ff -m merge side`.quiet();
  const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  const memo = new GitReadMemo();
  await git.prefetchLastTouchingCommits(repo, head, pathspecLists(), memo);
  expect(memo.lastTouching.size).toBe(0);
});

test("a list under another list's exclusion is not walked", async () => {
  const { repo, heads } = await randomHistory(12);
  const head = heads[24]!;
  const memo = new GitReadMemo();
  const sidecar = [
    git.literalPathspec("skills/a/.capshelf.yml"),
    git.literalPathspec("skills/ab"),
  ];
  await git.prefetchLastTouchingCommits(
    repo,
    head,
    [
      git.contentCommitPathspecs("skills/a"),
      sidecar,
      git.contentCommitPathspecs("skills/a-b"),
    ],
    memo,
  );
  expect(memo.lastTouching.has(JSON.stringify([repo, head, sidecar]))).toBe(
    false,
  );
  expect(memo.lastTouching.size).toBe(2);
});
