import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  formatPercent,
  formatSigned,
  nearestIndex,
  niceTicks,
  parseSelection,
  resolveRange,
  selectionHash,
  seriesPoints,
  sliceHistory,
  summarize,
  timeTicks,
  valueDomain,
} from "./series";
import type { LocCommit } from "./types";

function commit(
  date: string,
  prod: number,
  test: number,
  sha = date,
): LocCommit {
  return { sha, short: sha.slice(0, 7), date, subject: sha, prod, test };
}

const NOW = Date.parse("2026-09-06T12:00:00Z");

const HISTORY: LocCommit[] = [
  commit("2026-06-01T10:00:00Z", 100, 50),
  commit("2026-08-01T10:00:00Z", 200, 120),
  commit("2026-08-20T10:00:00Z", 260, 150),
  commit("2026-09-05T10:00:00Z", 300, 210),
];

describe("selection hash", () => {
  test("round-trips every selection kind", () => {
    for (const hash of ["#/7d", "#/30d", "#/90d", "#/365d", "#/all"]) {
      expect(selectionHash(parseSelection(hash))).toBe(hash);
    }
    expect(selectionHash(parseSelection("#/2026-08-01..2026-08-31"))).toBe(
      "#/2026-08-01..2026-08-31",
    );
  });

  test("an unknown or empty hash is the 30 day default", () => {
    expect(parseSelection("")).toEqual({ kind: "days", days: 30 });
    expect(parseSelection("#/12d")).toEqual({ kind: "days", days: 30 });
    expect(parseSelection("#/junk")).toEqual({ kind: "days", days: 30 });
  });

  test("a backwards custom range is put in order", () => {
    expect(parseSelection("#/2026-08-31..2026-08-01")).toEqual({
      kind: "custom",
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });
});

describe("resolveRange", () => {
  test("a preset ends now and starts that many days earlier", () => {
    const range = resolveRange({ kind: "days", days: 30 }, NOW, null);
    expect(range.end).toBe(NOW);
    expect(range.start).toBe(NOW - 30 * DAY_MS);
  });

  test("all starts at the first commit", () => {
    const first = Date.parse("2026-06-01T10:00:00Z");
    expect(resolveRange({ kind: "all" }, NOW, first)).toEqual({
      start: first,
      end: NOW,
    });
  });

  test("all without commits still spans a day", () => {
    const range = resolveRange({ kind: "all" }, NOW, null);
    expect(range.end - range.start).toBe(DAY_MS);
  });

  test("a custom range covers whole local days", () => {
    const range = resolveRange(
      { kind: "custom", from: "2026-08-01", to: "2026-08-01" },
      NOW,
      null,
    );
    expect(range.end - range.start).toBe(DAY_MS);
  });
});

describe("sliceHistory", () => {
  const range = resolveRange({ kind: "days", days: 30 }, NOW, null);

  test("keeps the commits inside and carries the last one before", () => {
    const slice = sliceHistory(HISTORY, range);
    expect(slice.inside.map((entry) => entry.sha)).toEqual([
      "2026-08-20T10:00:00Z",
      "2026-09-05T10:00:00Z",
    ]);
    expect(slice.carried?.sha).toBe("2026-08-01T10:00:00Z");
  });

  test("a range before the first commit carries nothing", () => {
    const early = { start: NOW - 200 * DAY_MS, end: NOW - 150 * DAY_MS };
    const slice = sliceHistory(HISTORY, early);
    expect(slice.inside).toEqual([]);
    expect(slice.carried).toBeNull();
  });

  test("a commit at the exclusive end is outside", () => {
    const at = { start: NOW - DAY_MS, end: Date.parse("2026-09-05T10:00:00Z") };
    expect(sliceHistory(HISTORY, at).inside).toEqual([]);
  });
});

describe("summarize", () => {
  test("start comes from the carried commit and end from the last inside", () => {
    const range = resolveRange({ kind: "days", days: 30 }, NOW, null);
    const summary = summarize(sliceHistory(HISTORY, range), range);
    expect(summary.start).toEqual({ prod: 200, test: 120 });
    expect(summary.end).toEqual({ prod: 300, test: 210 });
    expect(summary.commits).toBe(2);
    expect(summary.days).toBe(30);
  });

  test("an empty range still ends at the carried value", () => {
    const range = { start: NOW - 5 * DAY_MS, end: NOW - 2 * DAY_MS };
    const summary = summarize(sliceHistory(HISTORY, range), range);
    expect(summary.start).toEqual({ prod: 260, test: 150 });
    expect(summary.end).toEqual({ prod: 260, test: 150 });
    expect(summary.commits).toBe(0);
    expect(summary.days).toBe(3);
  });

  test("nothing before the first commit gives null values", () => {
    const range = { start: NOW - 200 * DAY_MS, end: NOW - 150 * DAY_MS };
    const summary = summarize(sliceHistory(HISTORY, range), range);
    expect(summary.start).toBeNull();
    expect(summary.end).toBeNull();
  });
});

describe("seriesPoints", () => {
  test("carries into the left edge and holds to the right edge", () => {
    const range = resolveRange({ kind: "days", days: 30 }, NOW, null);
    const points = seriesPoints(sliceHistory(HISTORY, range), range, "prod");
    expect(points[0]).toEqual({ time: range.start, value: 200, commit: null });
    expect(points[points.length - 1]).toEqual({
      time: range.end,
      value: 300,
      commit: null,
    });
    expect(points.filter((point) => point.commit !== null)).toHaveLength(2);
  });

  test("no history means no points", () => {
    const range = { start: NOW - 200 * DAY_MS, end: NOW - 150 * DAY_MS };
    expect(seriesPoints(sliceHistory(HISTORY, range), range, "test")).toEqual(
      [],
    );
  });
});

describe("ticks", () => {
  test("niceTicks lands on round numbers", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(14_200, 21_300, 5)).toEqual([16_000, 18_000, 20_000]);
  });

  test("valueDomain contains the data and never dips below zero", () => {
    const domain = valueDomain([14_200, 21_300]);
    expect(domain.min).toBeLessThanOrEqual(14_200);
    expect(domain.max).toBeGreaterThanOrEqual(21_300);
    expect(domain.ticks[0]).toBeGreaterThanOrEqual(domain.min);
    expect(domain.ticks[domain.ticks.length - 1]).toBeLessThanOrEqual(
      domain.max,
    );
    expect(valueDomain([0, 3]).min).toBe(0);
  });

  test("a flat series still gets a domain with height", () => {
    const domain = valueDomain([500, 500]);
    expect(domain.max).toBeGreaterThan(domain.min);
    expect(domain.ticks.length).toBeGreaterThan(1);
  });

  test("timeTicks uses days for short ranges and months for long ones", () => {
    const week = timeTicks({ start: NOW - 7 * DAY_MS, end: NOW }, 8);
    expect(week).toHaveLength(7);
    expect(week.every((tick) => new Date(tick.time).getHours() === 0)).toBe(
      true,
    );
    const year = timeTicks({ start: NOW - 365 * DAY_MS, end: NOW }, 8);
    expect(year.length).toBeLessThanOrEqual(8);
    expect(year.every((tick) => new Date(tick.time).getDate() === 1)).toBe(
      true,
    );
  });
});

describe("formats", () => {
  test("signed integers and percents", () => {
    expect(formatSigned(1234)).toBe("+1,234");
    expect(formatSigned(-5)).toBe("−5");
    expect(formatSigned(0)).toBe("±0");
    expect(formatPercent(50, 200)).toBe("+25%");
    expect(formatPercent(-3, 200)).toBe("−1.5%");
    expect(formatPercent(3, 0)).toBe("");
  });
});

describe("nearestIndex", () => {
  test("finds the closest time on either side", () => {
    const times = [10, 20, 30];
    expect(nearestIndex(times, 0)).toBe(0);
    expect(nearestIndex(times, 14)).toBe(0);
    expect(nearestIndex(times, 16)).toBe(1);
    expect(nearestIndex(times, 25)).toBe(1);
    expect(nearestIndex(times, 100)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });
});
