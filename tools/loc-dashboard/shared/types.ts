/**
 * The API between `serve.ts` and the client. Every number here is computed
 * by `collect.ts` from the repository's git history; the client only
 * filters, slices, and draws.
 */

export type SeriesId = "prod" | "test";

export interface LocCommit {
  sha: string;
  short: string;
  /** ISO 8601 committer date. */
  date: string;
  subject: string;
  prod: number;
  test: number;
}

export interface LocRuleText {
  series: SeriesId;
  description: string;
}

export interface LocHistory {
  repo: string;
  /** The repository path with the home directory shortened to `~`. */
  display: string;
  branch: string;
  head: string;
  generatedAt: string;
  rules: LocRuleText[];
  /** Ascending by committer date along the first-parent chain. */
  commits: LocCommit[];
}

export interface LocDirectory {
  dir: string;
  lines: number;
  files: number;
}

export interface LocBreakdown {
  sha: string;
  prod: LocDirectory[];
  test: LocDirectory[];
}

export interface ApiErrorBody {
  error: { message: string; hint?: string };
}

/** A coverage run: `bun test --coverage` with the lcov reporter. */
export interface CoverageFile {
  path: string;
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
}

export interface CoverageThreshold {
  /** Fractions, as bunfig.toml writes them: 0.85 means 85 percent. */
  line: number | null;
  function: number | null;
}

export interface CoverageResult {
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
  files: CoverageFile[];
  threshold: CoverageThreshold;
  meets: boolean;
  testsPassed: number | null;
  testsFailed: number | null;
  /** Names of failing tests, at most the first twenty. */
  failedTests: string[];
  durationMs: number;
}

export interface OxlintRule {
  code: string;
  count: number;
}

export interface OxlintFile {
  path: string;
  count: number;
}

export interface OxlintResult {
  errors: number;
  warnings: number;
  filesChecked: number;
  rules: OxlintRule[];
  files: OxlintFile[];
  durationMs: number;
}

export interface MeasureFailure {
  error: string;
}

export interface MeasureRun {
  /** ISO 8601 time the run started. */
  at: string;
  sha: string;
  short: string;
  /** Tracked files differed from HEAD when the run started. */
  dirty: boolean;
  coverage: CoverageResult | MeasureFailure;
  oxlint: OxlintResult | MeasureFailure;
}

export type MeasureStep = "coverage" | "oxlint";

export interface MeasuresState {
  running: boolean;
  step: MeasureStep | null;
  startedAt: string | null;
  latest: MeasureRun | null;
  /** Every recorded run, oldest first, without per-file detail. */
  history: MeasureHistoryPoint[];
}

export interface MeasureHistoryPoint {
  at: string;
  short: string;
  dirty: boolean;
  lines: number | null;
  functions: number | null;
  errors: number | null;
  warnings: number | null;
}
