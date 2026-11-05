// Time the one history walk against one `git log -1` per item, on long
// histories that `git fast-import` builds in a few seconds.
//
// Usage: bun tools/perf/walk-bench.ts [commits] [items]
//
// Two histories are built. In the first, every item changes in the newest
// commits, so the walk stops early. In the second, items change only in the
// first commit, so the walk reads the whole history. Each line prints the
// walk time, the number of answers it filled, and the time of the separate
// `log -1` calls. The walk must fill every answer in both cases.
import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentCommitPathspecs,
  lastTouchingContentCommit,
  prefetchLastTouchingCommits,
} from "../../src/git";
import { GitReadMemo } from "../../src/git-read-memo";

const commits = Number(process.argv[2] ?? 20_000);
const items = Number(process.argv[3] ?? 10);

async function history(recent: boolean): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "capshelf-perf-walk-"));
  await $`git -C ${repo} init -q -b main`.quiet();
  const lines: string[] = [];
  for (let n = 0; n < commits; n++) {
    lines.push(
      "commit refs/heads/main",
      `committer perf <perf@example.invalid> ${1_700_000_000 + n} +0000`,
      "data 1",
      "x",
    );
    const touched =
      n === 0
        ? Array.from({ length: items }, (_, i) => `skills/s${i}/SKILL.md`)
        : recent && n >= commits - 4 * items
          ? [`skills/s${n % items}/SKILL.md`]
          : [`other/f${n % 50}`];
    for (const path of touched) {
      const body = `${n}`;
      lines.push(`M 100644 inline ${path}`, `data ${body.length}`, body);
    }
  }
  await $`git -C ${repo} fast-import --quiet < ${new Response(`${lines.join("\n")}\n`)}`.quiet();
  return repo;
}

for (const recent of [true, false]) {
  const repo = await history(recent);
  try {
    const head = (await $`git -C ${repo} rev-parse refs/heads/main`.text()).trim();
    const roots = Array.from({ length: items }, (_, i) => `skills/s${i}`);
    const lists = roots.map((root) => contentCommitPathspecs(root));
    for (let round = 0; round < 3; round++) {
      let start = performance.now();
      const memo = new GitReadMemo();
      await prefetchLastTouchingCommits(repo, head, lists, memo);
      const walk = performance.now() - start;
      start = performance.now();
      for (const root of roots) {
        await lastTouchingContentCommit(repo, root, { head });
      }
      const separate = performance.now() - start;
      console.log(
        `${recent ? "items changed recently" : "items changed only first"}: ` +
          `walk ${walk.toFixed(0)} ms (${memo.lastTouching.size}/${items} answers), ` +
          `${items} x log -1 ${separate.toFixed(0)} ms`,
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
