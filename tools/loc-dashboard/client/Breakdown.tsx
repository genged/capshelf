/**
 * Where the lines live at the end of the range, one row per directory, and
 * how far each moved since the start of the range.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { formatInt, formatSigned } from "../shared/series";
import type { LocBreakdown, LocDirectory, SeriesId } from "../shared/types";
import { apiGet } from "./api";
import { SERIES_LABEL, SeriesKey } from "./Tiles";

const MAX_ROWS = 8;
const cache = new Map<string, Promise<LocBreakdown>>();

function loadBreakdown(sha: string): Promise<LocBreakdown> {
  const cached = cache.get(sha);
  if (cached) return cached;
  const promise = apiGet<LocBreakdown>("/api/breakdown", { sha });
  cache.set(sha, promise);
  promise.catch(() => cache.delete(sha));
  return promise;
}

export function clearBreakdownCache(): void {
  cache.clear();
}

export function Breakdown({
  endSha,
  startSha,
  hidden,
}: {
  endSha: string | null;
  startSha: string | null;
  hidden: ReadonlySet<SeriesId>;
}): JSX.Element {
  const [end, setEnd] = useState<LocBreakdown | null>(null);
  const [start, setStart] = useState<LocBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    if (endSha === null) {
      setEnd(null);
      setStart(null);
      return;
    }
    loadBreakdown(endSha).then(
      (value) => {
        if (live) setEnd(value);
      },
      (reason: Error) => {
        if (live) setError(reason.message);
      },
    );
    if (startSha === null || startSha === endSha) {
      setStart(null);
    } else {
      loadBreakdown(startSha).then(
        (value) => {
          if (live) setStart(value);
        },
        () => {
          if (live) setStart(null);
        },
      );
    }
    return () => {
      live = false;
    };
  }, [endSha, startSha]);

  const visible = (["prod", "test"] as const).filter(
    (series) => !hidden.has(series),
  );
  const max = end
    ? Math.max(
        1,
        ...visible.flatMap((series) => end[series].map((row) => row.lines)),
      )
    : 1;
  const stale = end !== null && end.sha !== endSha;

  return (
    <section class={`card breakdown${stale ? " is-refreshing" : ""}`}>
      <div class="card-head">
        <h2 class="card-title">Where the lines live</h2>
        <p class="card-lead">
          {end ? (
            <>
              At <span class="mono">{end.sha.slice(0, 7)}</span>, the last
              commit in the range
              {start ? ", with the change since the range start" : ""}.
            </>
          ) : error ? (
            error
          ) : endSha ? (
            "Reading the tree…"
          ) : (
            "No commit in or before this range."
          )}
        </p>
      </div>
      {end ? (
        <div class="breakdown-columns">
          {visible.map((series) => (
            <BreakdownColumn
              key={series}
              series={series}
              rows={end[series]}
              startRows={start ? start[series] : null}
              max={max}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function BreakdownColumn({
  series,
  rows,
  startRows,
  max,
}: {
  series: SeriesId;
  rows: LocDirectory[];
  startRows: LocDirectory[] | null;
  max: number;
}): JSX.Element {
  const shown = rows.slice(0, MAX_ROWS);
  const rest = rows.slice(MAX_ROWS);
  const total = rows.reduce((sum, row) => sum + row.lines, 0);
  const before = (dir: string): number | null => {
    if (startRows === null) return null;
    return startRows.find((row) => row.dir === dir)?.lines ?? 0;
  };
  const restLines = rest.reduce((sum, row) => sum + row.lines, 0);
  const restBefore =
    startRows === null
      ? null
      : startRows
          .filter((row) => !shown.some((entry) => entry.dir === row.dir))
          .reduce((sum, row) => sum + row.lines, 0);
  return (
    <div class="breakdown-column">
      <h3 class="kind-heading">
        <SeriesKey series={series} />
        {SERIES_LABEL[series]}
        <span class="kind-count">{formatInt(total)}</span>
      </h3>
      {rows.length === 0 ? (
        <p class="muted breakdown-empty">No file matches the rules.</p>
      ) : (
        <ul class="bars">
          {shown.map((row) => (
            <BarRow
              key={row.dir}
              series={series}
              label={row.dir}
              lines={row.lines}
              before={before(row.dir)}
              max={max}
              files={row.files}
            />
          ))}
          {rest.length > 0 ? (
            <BarRow
              series={series}
              label={`other (${rest.length})`}
              lines={restLines}
              before={restBefore}
              max={max}
              files={rest.reduce((sum, row) => sum + row.files, 0)}
              plain
            />
          ) : null}
        </ul>
      )}
    </div>
  );
}

function BarRow({
  series,
  label,
  lines,
  before,
  max,
  files,
  plain,
}: {
  series: SeriesId;
  label: string;
  lines: number;
  before: number | null;
  max: number;
  files: number;
  plain?: boolean;
}): JSX.Element {
  const delta = before === null ? null : lines - before;
  return (
    <li class="bar-row">
      <span
        class={plain ? "bar-label" : "bar-label mono"}
        title={`${files} ${files === 1 ? "file" : "files"}`}
      >
        {label}
      </span>
      <span class="bar-track">
        <span
          class={`bar-fill bar-fill-${series}`}
          style={{ width: `${Math.max(0.5, (lines / max) * 100)}%` }}
        />
      </span>
      <span class="bar-value">{formatInt(lines)}</span>
      <span class="bar-delta">{delta === null ? "" : formatSigned(delta)}</span>
    </li>
  );
}
