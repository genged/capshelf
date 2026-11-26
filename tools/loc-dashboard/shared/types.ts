export type SeriesId = "prod" | "test";

export interface LocCommit {
  sha: string;
  short: string;
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
  display: string;
  branch: string;
  head: string;
  generatedAt: string;
  rules: LocRuleText[];
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

export interface CoverageFile {
  path: string;
  linesHit: number;
  linesFound: number;
  functionsHit: number;
  functionsFound: number;
}

export interface CoverageThreshold {
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
  at: string;
  sha: string;
  short: string;
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
