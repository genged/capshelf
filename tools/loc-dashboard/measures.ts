/**
 * Test coverage and Oxlint results for the checkout. Neither can be read
 * from history the way line counts can, so a run measures the working tree
 * now, and every run is recorded in a local store so a history builds up.
 *
 * The parsers are pure and unit tested. The runner spawns `bun test` and
 * `oxlint` in the repository and never writes inside it.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type {
  CoverageFile,
  CoverageResult,
  CoverageThreshold,
  MeasureFailure,
  MeasureHistoryPoint,
  MeasureRun,
  MeasureStep,
  MeasuresState,
  OxlintResult,
} from "./shared/types";

const MAX_RUNS = 200;
const COVERAGE_TIMEOUT_MS = 15 * 60_000;
const OXLINT_TIMEOUT_MS = 5 * 60_000;
const TOP = 12;
const MAX_FAILED_TESTS = 20;

/** Sum an lcov report. Files are sorted by line coverage, lowest first. */
export function parseLcov(text: string): CoverageFile[] {
  const files: CoverageFile[] = [];
  let current: CoverageFile | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = {
        path: line.slice(3),
        linesHit: 0,
        linesFound: 0,
        functionsHit: 0,
        functionsFound: 0,
      };
      files.push(current);
    } else if (current === null) {
    } else if (line.startsWith("LF:")) {
      current.linesFound = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      current.linesHit = Number(line.slice(3));
    } else if (line.startsWith("FNF:")) {
      current.functionsFound = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      current.functionsHit = Number(line.slice(4));
    } else if (line === "end_of_record") {
      current = null;
    }
  }
  return files.sort(
    (a, b) =>
      ratio(a.linesHit, a.linesFound) - ratio(b.linesHit, b.linesFound) ||
      a.path.localeCompare(b.path),
  );
}

export function ratio(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found;
}

const BunfigSchema = z.object({
  test: z
    .object({
      coverageThreshold: z
        .union([
          z.number().transform((value) => ({ line: value, function: value })),
          z.object({
            line: z.number().optional(),
            function: z.number().optional(),
          }),
        ])
        .optional(),
    })
    .optional(),
});

/** The `[test] coverageThreshold` table in bunfig.toml, when it exists. */
export function parseThreshold(bunfig: string | null): CoverageThreshold {
  const none: CoverageThreshold = { line: null, function: null };
  if (bunfig === null) return none;
  let document: unknown;
  try {
    document = parseToml(bunfig);
  } catch {
    return none;
  }
  const parsed = BunfigSchema.safeParse(document);
  if (!parsed.success) return none;
  const threshold = parsed.data.test?.coverageThreshold;
  if (threshold === undefined) return none;
  return {
    line: threshold.line ?? null,
    function: threshold.function ?? null,
  };
}

export function summarizeCoverage(
  files: CoverageFile[],
  threshold: CoverageThreshold,
  stderr: string,
  durationMs: number,
): CoverageResult {
  const totals = files.reduce(
    (sum, file) => ({
      linesHit: sum.linesHit + file.linesHit,
      linesFound: sum.linesFound + file.linesFound,
      functionsHit: sum.functionsHit + file.functionsHit,
      functionsFound: sum.functionsFound + file.functionsFound,
    }),
    { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0 },
  );
  const lines = ratio(totals.linesHit, totals.linesFound);
  const functions = ratio(totals.functionsHit, totals.functionsFound);
  const meets =
    (threshold.line === null || lines >= threshold.line) &&
    (threshold.function === null || functions >= threshold.function);
  const passed = /^\s*(\d+) pass$/m.exec(stderr);
  const failed = /^\s*(\d+) fail$/m.exec(stderr);
  // Bun appends the duration to a slow failure: `name [5006.58ms]`.
  const failedTests = [
    ...stderr.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm),
  ]
    .map((match) => match[1] ?? "")
    .filter(
      (name, index, names) => name !== "" && names.indexOf(name) === index,
    )
    .slice(0, MAX_FAILED_TESTS);
  return {
    ...totals,
    files,
    threshold,
    meets,
    testsPassed: passed?.[1] === undefined ? null : Number(passed[1]),
    testsFailed: failed?.[1] === undefined ? null : Number(failed[1]),
    failedTests,
    durationMs,
  };
}

const OxlintReportSchema = z.object({
  diagnostics: z
    .array(
      z.object({
        code: z.string().default("?"),
        severity: z.string().default("advice"),
        filename: z.string().default("?"),
      }),
    )
    .default([]),
  number_of_files: z.number().default(0),
});

/** Count `oxlint --format json` output by severity, rule, and file. */
export function summarizeOxlint(
  text: string,
  durationMs: number,
): OxlintResult {
  const report = OxlintReportSchema.parse(JSON.parse(text));
  let errors = 0;
  let warnings = 0;
  const rules = new Map<string, number>();
  const files = new Map<string, number>();
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.severity === "error") errors += 1;
    else if (diagnostic.severity === "warning") warnings += 1;
    else continue;
    rules.set(diagnostic.code, (rules.get(diagnostic.code) ?? 0) + 1);
    files.set(diagnostic.filename, (files.get(diagnostic.filename) ?? 0) + 1);
  }
  return {
    errors,
    warnings,
    filesChecked: report.number_of_files,
    rules: sortedTop(rules).map(([code, count]) => ({ code, count })),
    files: sortedTop(files).map(([path, count]) => ({ path, count })),
    durationMs,
  };
}

function sortedTop(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP);
}

export function historyPoint(run: MeasureRun): MeasureHistoryPoint {
  const coverage = "error" in run.coverage ? null : run.coverage;
  const oxlint = "error" in run.oxlint ? null : run.oxlint;
  return {
    at: run.at,
    short: run.short,
    dirty: run.dirty,
    lines: coverage ? ratio(coverage.linesHit, coverage.linesFound) : null,
    functions: coverage
      ? ratio(coverage.functionsHit, coverage.functionsFound)
      : null,
    errors: oxlint ? oxlint.errors : null,
    warnings: oxlint ? oxlint.warnings : null,
  };
}

/** Runs live under the cache directory, one file per repository path. */
export function storePath(repo: string): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const key = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  return join(base, "loc-dashboard", `${key}.json`);
}

interface StoreFile {
  version: 1;
  repo: string;
  runs: MeasureRun[];
}

export async function readStore(path: string): Promise<MeasureRun[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    // SAFETY: the file is written only by writeStore below; a hand-edited
    // or foreign file that lacks `runs` reads as an empty store.
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

export async function writeStore(
  path: string,
  repo: string,
  runs: MeasureRun[],
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const file: StoreFile = { version: 1, repo, runs: runs.slice(-MAX_RUNS) };
  await writeFile(path, `${JSON.stringify(file)}\n`);
}

interface Spawned {
  stdout: string;
  stderr: string;
  exit: number;
  durationMs: number;
}

async function spawn(
  cwd: string,
  command: string[],
  timeoutMs: number,
): Promise<Spawned> {
  const started = performance.now();
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    stdout,
    stderr,
    exit,
    durationMs: Math.round(performance.now() - started),
  };
}

async function gitHead(repo: string): Promise<{ sha: string; dirty: boolean }> {
  const head = await spawn(repo, ["git", "rev-parse", "HEAD"], 30_000);
  if (head.exit !== 0)
    throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim()}`);
  const status = await spawn(
    repo,
    ["git", "status", "--porcelain", "--untracked-files=no"],
    60_000,
  );
  return { sha: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

async function runCoverage(
  repo: string,
): Promise<CoverageResult | MeasureFailure> {
  const dir = await mkdtemp(join(tmpdir(), "loc-dashboard-coverage-"));
  try {
    const result = await spawn(
      repo,
      [
        "bun",
        "test",
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${dir}`,
        "--parallel=4",
      ],
      COVERAGE_TIMEOUT_MS,
    );
    let lcov: string;
    try {
      lcov = await readFile(join(dir, "lcov.info"), "utf8");
    } catch {
      return {
        error: `bun test wrote no lcov report (exit ${result.exit}): ${lastLines(result.stderr)}`,
      };
    }
    let bunfig: string | null;
    try {
      bunfig = await readFile(join(repo, "bunfig.toml"), "utf8");
    } catch {
      bunfig = null;
    }
    return summarizeCoverage(
      parseLcov(lcov),
      parseThreshold(bunfig),
      result.stderr,
      result.durationMs,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runOxlint(repo: string): Promise<OxlintResult | MeasureFailure> {
  const result = await spawn(
    repo,
    ["bun", "--bun", "oxlint", "--format", "json"],
    OXLINT_TIMEOUT_MS,
  );
  // Exit 1 means findings. Anything above is a crash or a bad invocation.
  if (result.exit > 1) {
    return {
      error: `oxlint exited ${result.exit}: ${lastLines(result.stderr)}`,
    };
  }
  try {
    return summarizeOxlint(result.stdout, result.durationMs);
  } catch {
    return { error: `oxlint printed no JSON: ${lastLines(result.stderr)}` };
  }
}

function lastLines(text: string, count = 3): string {
  return text.trim().split("\n").slice(-count).join(" ");
}

/**
 * Owns the store and the one run at a time. `state()` is what the API
 * returns; `start()` begins a run unless one is already going.
 */
export class Measures {
  readonly repo: string;
  private readonly path: string;
  private runs: MeasureRun[] = [];
  private running: Promise<void> | null = null;
  private step: MeasureStep | null = null;
  private startedAt: string | null = null;

  constructor(repo: string) {
    this.repo = repo;
    this.path = storePath(repo);
  }

  async load(): Promise<void> {
    this.runs = await readStore(this.path);
  }

  state(): MeasuresState {
    return {
      running: this.running !== null,
      step: this.step,
      startedAt: this.startedAt,
      latest: this.runs[this.runs.length - 1] ?? null,
      history: this.runs.map(historyPoint),
    };
  }

  /** True when the newest run measured the current clean HEAD. */
  async isCurrent(): Promise<boolean> {
    const latest = this.runs[this.runs.length - 1];
    if (!latest || latest.dirty) return false;
    const head = await gitHead(this.repo);
    return !head.dirty && head.sha === latest.sha;
  }

  start(): Promise<void> {
    if (this.running) return this.running;
    this.startedAt = new Date().toISOString();
    this.running = this.execute().finally(() => {
      this.running = null;
      this.step = null;
      this.startedAt = null;
    });
    return this.running;
  }

  private async execute(): Promise<void> {
    const at = this.startedAt ?? new Date().toISOString();
    const head = await gitHead(this.repo);
    this.step = "coverage";
    const coverage = await runCoverage(this.repo);
    this.step = "oxlint";
    const oxlint = await runOxlint(this.repo);
    const run: MeasureRun = {
      at,
      sha: head.sha,
      short: head.sha.slice(0, 7),
      dirty: head.dirty,
      coverage,
      oxlint,
    };
    this.runs = [...this.runs, run].slice(-MAX_RUNS);
    await writeStore(this.path, this.repo, this.runs);
  }
}
