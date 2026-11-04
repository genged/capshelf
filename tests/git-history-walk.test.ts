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

test("a gitlink change under a submodule ignore setting selects its commit", async () => {
  const repo = await tempRepo("capshelf-walk-gitlink-");
  for (const file of ["skills/a/f", "skills/b/f"]) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), "1\n");
  }
  await $`git -C ${repo} add -A`.quiet();
  await $`git -C ${repo} commit -qm c1`.quiet();
  const first = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  // The gitlink names any commit id; Git does not need the submodule.
  await $`git -C ${repo} update-index --add --cacheinfo 160000,${first},skills/a/mod`.quiet();
  await writeFile(
    join(repo, ".gitmodules"),
    '[submodule "m"]\n\tpath = skills/a/mod\n\turl = x\n\tignore = all\n',
  );
  await $`git -C ${repo} add .gitmodules`.quiet();
  await $`git -C ${repo} commit -qm c2`.quiet();
  await writeFile(join(repo, "skills/b/f"), "2\n");
  // Not `commit -a`: the gitlink has no directory, so `-a` would delete it.
  await $`git -C ${repo} add skills/b/f`.quiet();
  await $`git -C ${repo} commit -qm c3`.quiet();
  const third = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  await $`git -C ${repo} update-index --cacheinfo 160000,${third},skills/a/mod`.quiet();
  await $`git -C ${repo} commit -qm c4`.quiet();
  const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
  // `.gitmodules` sets `ignore = all` for every round. The second round also
  // sets `diff.ignoreSubmodules` in the repository configuration.
  for (const setting of ["none", "all"]) {
    await $`git -C ${repo} config --local diff.ignoreSubmodules ${setting}`.quiet();
    const memo = new GitReadMemo();
    const lists = [
      git.contentCommitPathspecs("skills/a"),
      git.contentCommitPathspecs("skills/b"),
    ];
    await git.prefetchLastTouchingCommits(repo, head, lists, memo);
    for (const pathspecs of lists) {
      expect(
        memo.lastTouching.get(JSON.stringify([repo, head, pathspecs])),
      ).toBe(await direct(repo, head, pathspecs));
    }
  }
});

test("a long history in many output chunks gives the same answers", async () => {
  const repo = await tempRepo("capshelf-walk-long-");
  // fast-import writes 3,000 commits quickly. Each touches one of 40 items,
  // and five items are touched only in the first commit.
  const items = Array.from({ length: 40 }, (_, i) => `skills/item-${i}`);
  const lines: string[] = [];
  for (let n = 0; n < 3000; n++) {
    lines.push(
      "commit refs/heads/main",
      `committer a <a@b> ${1_700_000_000 + n} +0000`,
      "data 1",
      "x",
    );
    const touched = n === 0 ? items : [items[5 + ((n * 7) % 35)]!];
    for (const item of touched) {
      const body = `${item} ${n} ${"long line ".repeat(8)}`;
      lines.push(
        `M 100644 inline ${item}/SKILL.md`,
        `data ${Buffer.byteLength(body)}`,
        body,
      );
    }
  }
  await $`git -C ${repo} fast-import --quiet < ${new Response(`${lines.join("\n")}\n`)}`.quiet();
  const head = (
    await $`git -C ${repo} rev-parse refs/heads/main`.text()
  ).trim();
  const memo = new GitReadMemo();
  const lists = items.map((item) => git.contentCommitPathspecs(item));
  await git.prefetchLastTouchingCommits(repo, head, lists, memo);
  const expected = new Map<string, string | null>();
  for (const pathspecs of lists) {
    const key = JSON.stringify([repo, head, pathspecs]);
    expected.set(key, await direct(repo, head, pathspecs));
    expect(memo.lastTouching.get(key)).toBe(expected.get(key)!);
  }

  // The reader gives the same answers for any chunk boundaries.
  const requests = items.map((item) => ({
    key: JSON.stringify([repo, head, git.contentCommitPathspecs(item)]),
    include: [item],
  }));
  const union = lists.flat();
  const proc = Bun.spawn(["git", "-C", repo, ...git.logWalkArgs(head, union)], {
    stdout: "pipe",
  });
  const output = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  expect(await proc.exited).toBe(0);
  const next = random(5);
  for (const most of [1, 3, 7, 64]) {
    const reader = new git.LogWalkReader(requests);
    let offset = 0;
    while (offset < output.length) {
      const size = 1 + Math.floor(next() * most);
      if (reader.feed(output.subarray(offset, offset + size))) break;
      offset += size;
    }
    expect({ most, answers: reader.finish() }).toEqual({
      most,
      answers: expected,
    });
  }
}, 120_000);

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
