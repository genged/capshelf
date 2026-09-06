/**
 * Pure functions between the history the server sends and what the client
 * draws. Nothing here touches the DOM or git, so every rule about ranges,
 * carry-forward, ticks, and number formats is a unit test.
 */
import type { LocCommit, SeriesId } from "./types";

export const DAY_MS = 86_400_000;

export type RangeSelection =
  | { kind: "days"; days: 7 | 30 | 90 | 365 }
  | { kind: "all" }
  | { kind: "custom"; from: string; to: string };

export const DEFAULT_SELECTION: RangeSelection = { kind: "days", days: 30 };

export const PRESETS: ReadonlyArray<{
  selection: RangeSelection;
  label: string;
}> = [
  { selection: { kind: "days", days: 7 }, label: "7d" },
  { selection: { kind: "days", days: 30 }, label: "30d" },
  { selection: { kind: "days", days: 90 }, label: "90d" },
  { selection: { kind: "days", days: 365 }, label: "1y" },
  { selection: { kind: "all" }, label: "All" },
];

export interface Range {
  /** Milliseconds since the epoch, inclusive. */
  start: number;
  /** Milliseconds since the epoch, exclusive. */
  end: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSelection(hash: string): RangeSelection {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const value = raw.startsWith("/") ? raw.slice(1) : raw;
  if (value === "all") return { kind: "all" };
  const days = /^(\d+)d$/.exec(value);
  if (days) {
    const count = Number(days[1]);
    if (count === 7 || count === 30 || count === 90 || count === 365) {
      return { kind: "days", days: count };
    }
    return DEFAULT_SELECTION;
  }
  const custom = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (custom && custom[1] !== undefined && custom[2] !== undefined) {
    return normalizeCustom(custom[1], custom[2]);
  }
  return DEFAULT_SELECTION;
}

export function selectionHash(selection: RangeSelection): string {
  switch (selection.kind) {
    case "all":
      return "#/all";
    case "days":
      return `#/${selection.days}d`;
    case "custom":
      return `#/${selection.from}..${selection.to}`;
  }
}

export function sameSelection(a: RangeSelection, b: RangeSelection): boolean {
  return selectionHash(a) === selectionHash(b);
}

/** A custom range never runs backwards; swapped dates are put in order. */
export function normalizeCustom(from: string, to: string): RangeSelection {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return DEFAULT_SELECTION;
  return from <= to
    ? { kind: "custom", from, to }
    : { kind: "custom", from: to, to: from };
}

/** Local midnight at the start of a `YYYY-MM-DD` day. */
export function dayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1).getTime();
}

export function toDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The window the selection names. Presets end now. "All" starts at the
 * first commit, or now when there is none, so an empty repository still
 * has a range to draw.
 */
export function resolveRange(
  selection: RangeSelection,
  now: number,
  firstCommit: number | null,
): Range {
  switch (selection.kind) {
    case "days":
      return { start: now - selection.days * DAY_MS, end: now };
    case "all": {
      const start = firstCommit ?? now - DAY_MS;
      return { start: Math.min(start, now - DAY_MS), end: now };
    }
    case "custom":
      return {
        start: dayStart(selection.from),
        end: dayStart(selection.to) + DAY_MS,
      };
  }
}

export function commitTime(commit: LocCommit): number {
  return Date.parse(commit.date);
}

export interface Slice {
  /** Commits inside the range, ascending. */
  inside: LocCommit[];
  /** The last commit before the range; its values carry into the range. */
  carried: LocCommit | null;
}

export function sliceHistory(commits: LocCommit[], range: Range): Slice {
  const inside: LocCommit[] = [];
  let carried: LocCommit | null = null;
  for (const commit of commits) {
    const time = commitTime(commit);
    if (time < range.start) {
      carried = commit;
    } else if (time < range.end) {
      inside.push(commit);
    }
  }
  return { inside, carried };
}

export interface SeriesValues {
  prod: number;
  test: number;
}

export interface Summary {
  /** The values at the start of the range, or null before the first commit. */
  start: SeriesValues | null;
  /** The values at the end of the range, or null when nothing exists yet. */
  end: SeriesValues | null;
  commits: number;
  /** Whole days the range spans, at least one. */
  days: number;
}

export function summarize(slice: Slice, range: Range): Summary {
  const last = slice.inside[slice.inside.length - 1] ?? slice.carried;
  return {
    start: slice.carried ? values(slice.carried) : null,
    end: last ? values(last) : null,
    commits: slice.inside.length,
    days: Math.max(1, Math.round((range.end - range.start) / DAY_MS)),
  };
}

export function values(commit: LocCommit): SeriesValues {
  return { prod: commit.prod, test: commit.test };
}

export function ratio(value: SeriesValues): number | null {
  return value.prod === 0 ? null : value.test / value.prod;
}

/**
 * The points a series draws: a carried value at the left edge, every commit
 * inside, and the last value held to the right edge, because the count does
 * not change between commits.
 */
export interface Point {
  time: number;
  value: number;
  commit: LocCommit | null;
}

export function seriesPoints(
  slice: Slice,
  range: Range,
  series: SeriesId,
): Point[] {
  const points: Point[] = [];
  if (slice.carried) {
    points.push({
      time: range.start,
      value: slice.carried[series],
      commit: null,
    });
  }
  for (const commit of slice.inside) {
    points.push({ time: commitTime(commit), value: commit[series], commit });
  }
  const last = points[points.length - 1];
  if (last && last.time < range.end) {
    points.push({ time: range.end, value: last.value, commit: null });
  }
  return points;
}

/** Round tick steps: 1, 2, 5 times a power of ten, spanning the domain. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const rough = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 2.5, 5, 10].map((factor) => factor * power);
  const step =
    candidates.find((candidate) => span / candidate <= target) ??
    candidates[candidates.length - 1] ??
    rough;
  const ticks: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let value = first; value <= max + step / 1e6; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}

/**
 * The y domain: the data's extent with a little air above and below, and
 * tick values that land on round numbers. The floor never goes below zero.
 */
export interface ValueDomain {
  min: number;
  max: number;
  ticks: number[];
}

export function valueDomain(values: number[], target = 5): ValueDomain {
  if (values.length === 0) return { min: 0, max: 1, ticks: [0, 1] };
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (high === low) {
    const air = Math.max(1, Math.abs(low) * 0.05);
    high = low + air;
    low = Math.max(0, low - air);
  }
  const pad = (high - low) * 0.08;
  const min = Math.max(0, low - pad);
  const max = high + pad;
  return { min, max, ticks: niceTicks(min, max, target) };
}

export interface TimeTick {
  time: number;
  label: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Time ticks at local midnights: every day, every few days, every week, or
 * the first of each month, chosen so no more than `maxCount` labels appear.
 */
export function timeTicks(range: Range, maxCount: number): TimeTick[] {
  const days = (range.end - range.start) / DAY_MS;
  const stepDays = [1, 2, 3, 7, 14].find((step) => days / step <= maxCount);
  const ticks: TimeTick[] = [];
  if (stepDays !== undefined) {
    const first = new Date(range.start);
    first.setHours(0, 0, 0, 0);
    if (first.getTime() < range.start) first.setDate(first.getDate() + 1);
    for (
      let cursor = new Date(first);
      cursor.getTime() < range.end;
      cursor.setDate(cursor.getDate() + stepDays)
    ) {
      ticks.push({ time: cursor.getTime(), label: dayLabel(cursor) });
    }
    return ticks;
  }
  const monthStep = [1, 2, 3, 6, 12].find(
    (step) => days / (30.4 * step) <= maxCount,
  );
  const step = monthStep ?? 12;
  const first = new Date(range.start);
  first.setHours(0, 0, 0, 0);
  first.setDate(1);
  if (first.getTime() < range.start) first.setMonth(first.getMonth() + 1);
  for (
    let cursor = new Date(first);
    cursor.getTime() < range.end;
    cursor.setMonth(cursor.getMonth() + step)
  ) {
    ticks.push({ time: cursor.getTime(), label: monthLabel(cursor) });
  }
  return ticks;
}

export function dayLabel(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function monthLabel(date: Date): string {
  return date.getMonth() === 0
    ? String(date.getFullYear())
    : `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${formatDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    value,
  );
}

export function formatSigned(value: number): string {
  if (value === 0) return "±0";
  return `${value > 0 ? "+" : "−"}${formatInt(Math.abs(value))}`;
}

export function formatRatio(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export function formatSignedRatio(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "±0.00";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(2)}`;
}

export function formatPercent(delta: number, base: number): string {
  if (base === 0) return "";
  const percent = (delta / base) * 100;
  const rounded =
    Math.abs(percent) < 10 ? percent.toFixed(1) : percent.toFixed(0);
  return `${percent > 0 ? "+" : percent < 0 ? "−" : "±"}${rounded.replace("-", "")}%`;
}

/** Binary search for the commit nearest to a time, by x distance. */
export function nearestIndex(times: number[], time: number): number {
  if (times.length === 0) return -1;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((times[mid] ?? 0) < time) low = mid + 1;
    else high = mid;
  }
  if (low > 0) {
    const before = times[low - 1] ?? 0;
    const here = times[low] ?? 0;
    if (Math.abs(before - time) <= Math.abs(here - time)) return low - 1;
  }
  return low;
}
