/**
 * Read a repository's first-parent history and count production and test
 * lines at every commit. Blob counts are cached by blob id, so a commit
 * costs one `git ls-tree` plus a `git cat-file --batch` pass over the blobs
 * no earlier commit already counted.
 */
import { homedir } from "node:os";
import { LineCounter } from "./count";
import { classify, groupDirectory, ruleTexts } from "./rules";
import type {
  LocBreakdown,
  LocCommit,
  LocDirectory,
  LocHistory,
  SeriesId,
} from "./shared/types";

const COMMITS_PER_BATCH = 40;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

interface TreeEntry {
  blob: string;
  path: string;
  series: SeriesId;
}

interface CommitHead {
  sha: string;
  date: string;
  subject: string;
}

export class LocCollector {
  readonly repo: string;
  readonly branch: string;
  private readonly blobLines = new Map<string, number>();
  private readonly commitTotals = new Map<
    string,
    { prod: number; test: number }
  >();

  private constructor(repo: string, branch: string) {
    this.repo = repo;
    this.branch = branch;
  }

  static async open(path: string, branch?: string): Promise<LocCollector> {
    const root = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
    const name =
      branch ?? (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return new LocCollector(root, name);
  }

  async history(): Promise<LocHistory> {
    const heads = await this.listCommits();
    const pending = heads.filter((head) => !this.commitTotals.has(head.sha));
    for (let index = 0; index < pending.length; index += COMMITS_PER_BATCH) {
      await this.countBatch(pending.slice(index, index + COMMITS_PER_BATCH));
    }
    const commits: LocCommit[] = heads.map((head) => {
      const totals = this.commitTotals.get(head.sha) ?? { prod: 0, test: 0 };
      return {
        sha: head.sha,
        short: head.sha.slice(0, 7),
        date: head.date,
        subject: head.subject,
        prod: totals.prod,
        test: totals.test,
      };
    });
    const head = heads[heads.length - 1]?.sha.slice(0, 7) ?? "";
    return {
      repo: this.repo,
      display: homeDisplay(this.repo),
      branch: this.branch,
      head,
      generatedAt: new Date().toISOString(),
      rules: ruleTexts(),
      commits,
    };
  }

  async breakdown(sha: string): Promise<LocBreakdown> {
    const entries = await this.treeEntries(sha);
    await this.ensureCounts(entries);
    const groups: Record<SeriesId, Map<string, LocDirectory>> = {
      prod: new Map(),
      test: new Map(),
    };
    for (const entry of entries) {
      const dir = groupDirectory(entry.path);
      const group = groups[entry.series];
      const row = group.get(dir) ?? { dir, lines: 0, files: 0 };
      row.lines += this.blobLines.get(entry.blob) ?? 0;
      row.files += 1;
      group.set(dir, row);
    }
    const sorted = (group: Map<string, LocDirectory>): LocDirectory[] =>
      [...group.values()].sort(
        (a, b) => b.lines - a.lines || a.dir.localeCompare(b.dir),
      );
    return { sha, prod: sorted(groups.prod), test: sorted(groups.test) };
  }

  private async listCommits(): Promise<CommitHead[]> {
    const raw = await git(this.repo, [
      "log",
      "--first-parent",
      "--reverse",
      "-z",
      "--format=%H%x1f%cI%x1f%s",
      this.branch,
      "--",
    ]);
    const heads: CommitHead[] = [];
    for (const record of raw.split("\0")) {
      if (record.length === 0) continue;
      const [sha, date, subject] = record.split("\x1f");
      if (sha === undefined || date === undefined) continue;
      heads.push({ sha, date, subject: subject ?? "" });
    }
    return heads;
  }

  private async countBatch(heads: CommitHead[]): Promise<void> {
    const trees = new Map<string, TreeEntry[]>();
    for (const head of heads) {
      trees.set(head.sha, await this.treeEntries(head.sha));
    }
    await this.ensureCounts([...trees.values()].flat());
    for (const [sha, entries] of trees) {
      const totals = { prod: 0, test: 0 };
      for (const entry of entries) {
        totals[entry.series] += this.blobLines.get(entry.blob) ?? 0;
      }
      this.commitTotals.set(sha, totals);
    }
  }

  private async treeEntries(sha: string): Promise<TreeEntry[]> {
    const raw = await git(this.repo, ["ls-tree", "-r", "-z", sha, "--"]);
    const entries: TreeEntry[] = [];
    for (const record of raw.split("\0")) {
      if (record.length === 0) continue;
      const tab = record.indexOf("\t");
      if (tab < 0) continue;
      const [mode, type, blob] = record.slice(0, tab).split(" ");
      const path = record.slice(tab + 1);
      if (type !== "blob" || mode === "120000" || blob === undefined) continue;
      const series = classify(path);
      if (series === null) continue;
      entries.push({ blob, path, series });
    }
    return entries;
  }

  /** Count every blob in `entries` that the cache does not hold yet. */
  private async ensureCounts(entries: TreeEntry[]): Promise<void> {
    const missing = new Set<string>();
    for (const entry of entries) {
      if (!this.blobLines.has(entry.blob)) missing.add(entry.blob);
    }
    if (missing.size === 0) return;
    const counted = await countBlobs(this.repo, [...missing]);
    for (const [blob, lines] of counted) this.blobLines.set(blob, lines);
  }
}

export function homeDisplay(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim() || `exit ${exit}`}`,
    );
  }
  return stdout;
}

/**
 * One `git cat-file --batch` run over many blobs. The output is a header
 * line `<sha> blob <size>` followed by the bytes and one newline; it is
 * parsed as it streams, so the process never holds more than a chunk.
 */
export async function countBlobs(
  repo: string,
  blobs: string[],
): Promise<Map<string, number>> {
  const proc = Bun.spawn(["git", "cat-file", "--batch"], {
    cwd: repo,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const parser = new BatchParser();
  const reading = (async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(value);
    }
    parser.finish();
  })();
  const writer = proc.stdin;
  for (let index = 0; index < blobs.length; index += 500) {
    writer.write(`${blobs.slice(index, index + 500).join("\n")}\n`);
    await writer.flush();
  }
  await writer.end();
  const [, stderr, exit] = await Promise.all([
    reading,
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new GitError(`git cat-file --batch failed: ${stderr.trim()}`);
  }
  return parser.counts;
}

class BatchParser {
  readonly counts = new Map<string, number>();
  private header: number[] = [];
  private remaining = 0;
  private skipNewline = false;
  private blob = "";
  private counter = new LineCounter();

  feed(chunk: Uint8Array): void {
    let index = 0;
    while (index < chunk.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, chunk.length - index);
        this.counter.feed(chunk, index, index + take);
        index += take;
        this.remaining -= take;
        if (this.remaining === 0) {
          this.counts.set(this.blob, this.counter.finish());
          this.skipNewline = true;
        }
        continue;
      }
      if (this.skipNewline) {
        this.skipNewline = false;
        index += 1;
        continue;
      }
      const byte = chunk[index];
      index += 1;
      if (byte === 10) {
        this.startBody(String.fromCharCode(...this.header));
        this.header = [];
      } else if (byte !== undefined) {
        this.header.push(byte);
      }
    }
  }

  finish(): void {
    if (this.remaining > 0) {
      this.counts.set(this.blob, this.counter.finish());
      this.remaining = 0;
    }
  }

  private startBody(line: string): void {
    const [sha, kind, size] = line.split(" ");
    if (sha === undefined || kind !== "blob" || size === undefined) {
      if (sha !== undefined) this.counts.set(sha, 0);
      return;
    }
    this.blob = sha;
    this.remaining = Number(size);
    this.counter = new LineCounter();
    if (this.remaining === 0) {
      this.counts.set(sha, 0);
      this.skipNewline = true;
    }
  }
}
