import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocCollector, countBlobs } from "./collect";

let repo: string;

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

async function commit(
  files: Record<string, string>,
  subject: string,
  date: string,
): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await run(["add", "-A"]);
  await run([
    "-c",
    `user.name=t`,
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "--date",
    date,
    "-m",
    subject,
  ]);
  return run(["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "loc-dashboard-"));
  await run(["init", "-q", "-b", "main"]);
  process.env.GIT_COMMITTER_DATE = "2026-08-01T10:00:00Z";
  await commit(
    {
      "src/a.ts": "one\ntwo\n\nthree\n",
      "tests/a.test.ts": "x\n\n",
      "docs/readme.md": "not counted\n",
    },
    "first",
    "2026-08-01T10:00:00Z",
  );
  process.env.GIT_COMMITTER_DATE = "2026-08-02T10:00:00Z";
  await commit(
    {
      "src/a.ts": "one\ntwo\nthree\nfour\n",
      "src/ui/b.tsx": "<b />\n",
      "e2e/x.test.ts": "e\n2\ne\n",
      "scripts/smoke-ui.sh": "#!/bin/sh\necho hi\n",
    },
    "second",
    "2026-08-02T10:00:00Z",
  );
  delete process.env.GIT_COMMITTER_DATE;
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("LocCollector", () => {
  test("counts prod and test lines at every first-parent commit", async () => {
    const collector = await LocCollector.open(repo);
    const history = await collector.history();
    expect(history.branch).toBe("main");
    expect(history.commits).toHaveLength(2);
    const [first, second] = history.commits;
    expect(first?.subject).toBe("first");
    expect(first?.prod).toBe(3);
    expect(first?.test).toBe(1);
    expect(first?.date.startsWith("2026-08-01")).toBe(true);
    expect(second?.subject).toBe("second");
    expect(second?.prod).toBe(5);
    expect(second?.test).toBe(6);
    expect(history.head).toBe(second?.short ?? "");
    expect(history.rules.length).toBeGreaterThan(0);
  });

  test("a second read reuses the cache and sees a new commit", async () => {
    const collector = await LocCollector.open(repo);
    await collector.history();
    process.env.GIT_COMMITTER_DATE = "2026-08-03T10:00:00Z";
    await commit({ "src/c.ts": "c\n" }, "third", "2026-08-03T10:00:00Z");
    delete process.env.GIT_COMMITTER_DATE;
    const history = await collector.history();
    expect(history.commits.map((entry) => entry.subject)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(history.commits[2]?.prod).toBe(6);
  });

  test("breakdown groups a commit's files by directory", async () => {
    const collector = await LocCollector.open(repo);
    const history = await collector.history();
    const second = history.commits[1];
    if (!second) throw new Error("expected a second commit");
    const breakdown = await collector.breakdown(second.sha);
    expect(breakdown.prod).toEqual([
      { dir: "src", lines: 4, files: 1 },
      { dir: "src/ui", lines: 1, files: 1 },
    ]);
    expect(breakdown.test).toEqual([
      { dir: "e2e", lines: 3, files: 1 },
      { dir: "scripts", lines: 2, files: 1 },
      { dir: "tests", lines: 1, files: 1 },
    ]);
  });

  test("open rejects a directory that is not a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "loc-dashboard-plain-"));
    try {
      await expect(LocCollector.open(outside)).rejects.toThrow(/git/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("countBlobs", () => {
  test("counts an empty blob and a missing id without stalling", async () => {
    const empty = await run(["hash-object", "-w", "--stdin"]);
    const counts = await countBlobs(repo, [
      empty,
      "0000000000000000000000000000000000000000",
    ]);
    expect(counts.get(empty)).toBe(0);
    expect(counts.get("0000000000000000000000000000000000000000")).toBe(0);
  });
});
