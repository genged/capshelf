import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  historyPoint,
  parseLcov,
  parseThreshold,
  readStore,
  storePath,
  summarizeCoverage,
  summarizeOxlint,
  writeStore,
} from "./measures";
import type { MeasureRun } from "./shared/types";

const LCOV = `TN:
SF:src/a.ts
FNF:4
FNH:4
DA:1,1
LF:10
LH:9
end_of_record
TN:
SF:src/b.ts
FNF:2
FNH:1
LF:20
LH:5
end_of_record
`;

describe("parseLcov", () => {
  test("reads each file and sorts the least covered first", () => {
    const files = parseLcov(LCOV);
    expect(files.map((file) => file.path)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(files[0]).toEqual({
      path: "src/b.ts",
      linesHit: 5,
      linesFound: 20,
      functionsHit: 1,
      functionsFound: 2,
    });
  });

  test("an empty report is an empty list", () => {
    expect(parseLcov("")).toEqual([]);
  });
});

describe("parseThreshold", () => {
  test("reads the bunfig table", () => {
    expect(
      parseThreshold(
        "[test]\ncoverageThreshold = { line = 0.85, function = 0.90 }\n",
      ),
    ).toEqual({ line: 0.85, function: 0.9 });
  });

  test("a single number applies to both", () => {
    expect(parseThreshold("[test]\ncoverageThreshold = 0.8\n")).toEqual({
      line: 0.8,
      function: 0.8,
    });
  });

  test("no file, no table, or bad TOML means no threshold", () => {
    expect(parseThreshold(null)).toEqual({ line: null, function: null });
    expect(parseThreshold("[test]\nroot = 'tests'\n")).toEqual({
      line: null,
      function: null,
    });
    expect(parseThreshold("not = = toml")).toEqual({
      line: null,
      function: null,
    });
  });
});

describe("summarizeCoverage", () => {
  const files = parseLcov(LCOV);

  test("sums the files and judges the threshold", () => {
    const result = summarizeCoverage(
      files,
      { line: 0.4, function: 0.8 },
      "(fail) lock > rejects a bad pin [5006.58ms]\n(fail) lock > rejects a bad pin\n 12 pass\n 1 fail\nRan 13 tests\n",
      1234,
    );
    expect(result.linesHit).toBe(14);
    expect(result.linesFound).toBe(30);
    expect(result.functionsHit).toBe(5);
    expect(result.functionsFound).toBe(6);
    expect(result.meets).toBe(true);
    expect(result.testsPassed).toBe(12);
    expect(result.testsFailed).toBe(1);
    expect(result.failedTests).toEqual(["lock > rejects a bad pin"]);
    expect(result.durationMs).toBe(1234);
  });

  test("one failing threshold fails the whole", () => {
    const result = summarizeCoverage(
      files,
      { line: 0.5, function: null },
      "",
      0,
    );
    expect(result.meets).toBe(false);
    expect(result.testsPassed).toBeNull();
    expect(result.failedTests).toEqual([]);
  });
});

describe("summarizeOxlint", () => {
  test("counts by severity, rule, and file", () => {
    const report = JSON.stringify({
      diagnostics: [
        { code: "a(x)", severity: "error", filename: "src/a.ts" },
        { code: "a(x)", severity: "error", filename: "src/b.ts" },
        { code: "b(y)", severity: "warning", filename: "src/a.ts" },
        { code: "c(z)", severity: "advice", filename: "src/a.ts" },
      ],
      number_of_files: 7,
    });
    const result = summarizeOxlint(report, 50);
    expect(result.errors).toBe(2);
    expect(result.warnings).toBe(1);
    expect(result.filesChecked).toBe(7);
    expect(result.rules).toEqual([
      { code: "a(x)", count: 2 },
      { code: "b(y)", count: 1 },
    ]);
    expect(result.files).toEqual([
      { path: "src/a.ts", count: 2 },
      { path: "src/b.ts", count: 1 },
    ]);
  });

  test("a clean report has zero counts", () => {
    const result = summarizeOxlint('{"diagnostics":[],"number_of_files":3}', 5);
    expect(result.errors).toBe(0);
    expect(result.rules).toEqual([]);
  });
});

describe("store", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  test("round-trips runs and reads a missing file as empty", async () => {
    dir = await mkdtemp(join(tmpdir(), "loc-dashboard-store-"));
    const path = join(dir, "nested", "runs.json");
    expect(await readStore(path)).toEqual([]);
    const run: MeasureRun = {
      at: "2026-09-06T12:00:00.000Z",
      sha: "0123456789abcdef",
      short: "0123456",
      dirty: false,
      coverage: { error: "no" },
      oxlint: {
        errors: 3,
        warnings: 0,
        filesChecked: 2,
        rules: [],
        files: [],
        durationMs: 1,
      },
    };
    await writeStore(path, "/repo", [run]);
    expect(await readStore(path)).toEqual([run]);
    expect(historyPoint(run)).toEqual({
      at: run.at,
      short: "0123456",
      dirty: false,
      lines: null,
      functions: null,
      errors: 3,
      warnings: 0,
    });
  });

  test("the store path depends on the repository and the cache home", () => {
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/cache-home";
    try {
      const a = storePath("/repo/a");
      const b = storePath("/repo/b");
      expect(a.startsWith("/tmp/cache-home/loc-dashboard/")).toBe(true);
      expect(a).not.toBe(b);
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });
});
