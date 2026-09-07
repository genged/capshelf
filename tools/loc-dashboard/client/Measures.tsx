/**
 * Test coverage and Oxlint for the checkout. The latest run leads each
 * card; the runs inside the selected range draw a small step history once
 * there are two of them. A run measures the working tree now, so the card
 * names the commit and says when the tree had uncommitted changes.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  type Range,
  formatDateTime,
  formatInt,
  formatSigned,
} from "../shared/series";
import type {
  CoverageResult,
  MeasureHistoryPoint,
  MeasureRun,
  MeasuresState,
} from "../shared/types";
import { ApiError, apiGet } from "./api";
import { Icon } from "./icons";

const POLL_MS = 2000;
const LOWEST_FILES = 6;
const TOP_ROWS = 6;

export interface MeasuresHook {
  state: MeasuresState | null;
  error: string | null;
  run: () => void;
}

export function useMeasures(): MeasuresHook {
  const [state, setState] = useState<MeasuresState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    apiGet<MeasuresState>("/api/measures").then(
      (next) => {
        if (!live) return;
        setState(next);
        setError(null);
      },
      (reason: Error) => {
        if (live)
          setError(
            reason instanceof ApiError ? reason.message : String(reason),
          );
      },
    );
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    if (!state?.running) return;
    const id = window.setTimeout(() => setTick((value) => value + 1), POLL_MS);
    return () => window.clearTimeout(id);
  }, [state]);

  const run = (): void => {
    fetch("/api/measures/run", { method: "POST" }).then(
      () => setTick((value) => value + 1),
      () => setError("the dashboard server did not answer"),
    );
  };
  return { state, error, run };
}

export function Measures({
  state,
  error,
  range,
  onRun,
}: {
  state: MeasuresState | null;
  error: string | null;
  range: Range;
  onRun: () => void;
}): JSX.Element {
  const latest = state?.latest ?? null;
  const running = state?.running ?? false;
  const inRange = (state?.history ?? []).filter((point) => {
    const at = Date.parse(point.at);
    return at >= range.start && at < range.end;
  });
  return (
    <section class="measures" aria-label="Measures">
      <div class="measures-head">
        <div class="figure-titles">
          <h2 class="figure-title">Measures</h2>
          <p class="figure-lead">
            {latest ? (
              <>
                Last run {formatDateTime(Date.parse(latest.at))} at{" "}
                <span class="mono">{latest.short}</span>
                {latest.dirty ? " with uncommitted changes" : ""}. A run
                measures the working tree, not history.
              </>
            ) : (
              "No run recorded yet. A run measures the working tree, not history."
            )}
          </p>
        </div>
        <div class="measures-run">
          <button
            type="button"
            class="button"
            onClick={onRun}
            disabled={running}
            aria-busy={running}
          >
            <Icon name="refresh" />
            <span>
              {running ? "Running…" : latest ? "Run again" : "Run now"}
            </span>
          </button>
          <RunStatus state={state} />
        </div>
      </div>
      {error ? (
        <div class="notice notice-warn" role="alert">
          <p>{error}</p>
        </div>
      ) : null}
      <div class={`row measures-row${running ? " is-refreshing" : ""}`}>
        <CoverageCard run={latest} history={inRange} />
        <OxlintCard run={latest} history={inRange} />
      </div>
    </section>
  );
}

function RunStatus({
  state,
}: {
  state: MeasuresState | null;
}): JSX.Element | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!state?.running) return;
    const id = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [state?.running]);
  if (!state?.running || state.startedAt === null) return null;
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
  );
  return (
    <span class="refresh-time" aria-live="polite">
      {state.step === "oxlint" ? "Linting" : "Running tests"} · {seconds} s
    </span>
  );
}

function CoverageCard({
  run,
  history,
}: {
  run: MeasureRun | null;
  history: MeasureHistoryPoint[];
}): JSX.Element {
  const coverage = run && !("error" in run.coverage) ? run.coverage : null;
  const failure = run && "error" in run.coverage ? run.coverage.error : null;
  return (
    <section class="card measure-card">
      <div class="card-head">
        <h2 class="card-title">Test coverage</h2>
        <p class="card-lead">
          <span class="mono">bun test --coverage</span>
          {coverage
            ? ` · ${formatInt(coverage.files.length)} files loaded by tests · ${formatInt(coverage.testsPassed ?? 0)} passed${
                coverage.testsFailed
                  ? `, ${formatInt(coverage.testsFailed)} failed`
                  : ""
              } · ${Math.round(coverage.durationMs / 1000)} s`
            : " over the unit suite."}
        </p>
      </div>
      {coverage ? (
        <>
          <div class="measure-figures">
            <Figure
              label="Lines"
              value={percent(coverage.linesHit, coverage.linesFound)}
              note={`${formatInt(coverage.linesHit)} of ${formatInt(coverage.linesFound)}`}
              threshold={coverage.threshold.line}
            />
            <Figure
              label="Functions"
              value={percent(coverage.functionsHit, coverage.functionsFound)}
              note={`${formatInt(coverage.functionsHit)} of ${formatInt(coverage.functionsFound)}`}
              threshold={coverage.threshold.function}
            />
            <ThresholdBadge coverage={coverage} />
          </div>
          <MiniHistory
            history={history}
            series={[
              { key: "lines", label: "lines" },
              { key: "functions", label: "functions" },
            ]}
            format={(value) => `${(value * 100).toFixed(1)}%`}
            unit="percent"
          />
          {coverage.failedTests.length > 0 ? (
            <div class="measure-list">
              <h3 class="kind-heading">
                Failing tests
                <span class="kind-count">
                  {formatInt(
                    coverage.testsFailed ?? coverage.failedTests.length,
                  )}
                </span>
              </h3>
              <ul class="failed-tests">
                {coverage.failedTests.map((name) => (
                  <li key={name} class="failed-test">
                    <Icon name="alert" />
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <LowestFiles coverage={coverage} />
        </>
      ) : failure ? (
        <p class="measure-failure">{failure}</p>
      ) : (
        <p class="muted">No run yet.</p>
      )}
    </section>
  );
}

function ThresholdBadge({
  coverage,
}: {
  coverage: CoverageResult;
}): JSX.Element | null {
  const { line, function: fn } = coverage.threshold;
  if (line === null && fn === null) return null;
  const parts = [
    line === null ? null : `${Math.round(line * 100)}% lines`,
    fn === null ? null : `${Math.round(fn * 100)}% functions`,
  ].filter((part) => part !== null);
  return (
    <span class={`state-badge tone-${coverage.meets ? "ok" : "attention"}`}>
      <Icon name={coverage.meets ? "check" : "alert"} />
      <span>
        {coverage.meets ? "Meets" : "Below"} the threshold,{" "}
        {parts.join(" and ")}
      </span>
    </span>
  );
}

function LowestFiles({
  coverage,
}: {
  coverage: CoverageResult;
}): JSX.Element | null {
  const rows = coverage.files.slice(0, LOWEST_FILES);
  if (rows.length === 0) return null;
  const floor = coverage.threshold.line;
  return (
    <div class="measure-list">
      <h3 class="kind-heading">Least covered files</h3>
      <ul class="meters">
        {rows.map((file) => {
          const share =
            file.linesFound === 0 ? 1 : file.linesHit / file.linesFound;
          const below = floor !== null && share < floor;
          return (
            <li key={file.path} class="meter-row">
              <span class="meter-label mono" title={file.path}>
                {file.path}
              </span>
              <span class={`meter-track${below ? " is-attention" : ""}`}>
                <span
                  class="meter-fill"
                  style={{ width: `${Math.max(0.5, share * 100)}%` }}
                />
              </span>
              <span class="meter-value">{(share * 100).toFixed(0)}%</span>
              <span class="meter-note">
                {formatInt(file.linesHit)}/{formatInt(file.linesFound)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OxlintCard({
  run,
  history,
}: {
  run: MeasureRun | null;
  history: MeasureHistoryPoint[];
}): JSX.Element {
  const oxlint = run && !("error" in run.oxlint) ? run.oxlint : null;
  const failure = run && "error" in run.oxlint ? run.oxlint.error : null;
  return (
    <section class="card measure-card">
      <div class="card-head">
        <h2 class="card-title">Oxlint</h2>
        <p class="card-lead">
          <span class="mono">bun run lint:anti-slop</span>
          {oxlint
            ? ` · ${formatInt(oxlint.filesChecked)} files checked · ${(oxlint.durationMs / 1000).toFixed(1)} s`
            : " with the anti-slop plugin."}
        </p>
      </div>
      {oxlint ? (
        <>
          <div class="measure-figures">
            <Figure label="Errors" value={formatInt(oxlint.errors)} />
            <Figure label="Warnings" value={formatInt(oxlint.warnings)} />
            <span
              class={`state-badge tone-${oxlint.errors === 0 ? "ok" : "attention"}`}
            >
              <Icon name={oxlint.errors === 0 ? "check" : "alert"} />
              <span>
                {oxlint.errors === 0
                  ? "No errors"
                  : `${formatInt(oxlint.errors)} ${oxlint.errors === 1 ? "error" : "errors"} to fix`}
              </span>
            </span>
          </div>
          <MiniHistory
            history={history}
            series={[
              { key: "errors", label: "errors" },
              { key: "warnings", label: "warnings" },
            ]}
            format={(value) => formatInt(value)}
            unit="count"
          />
          <CountList
            title="By rule"
            rows={oxlint.rules.slice(0, TOP_ROWS).map((rule) => ({
              label: rule.code.replace(/^anti-slop\((.*)\)$/, "$1"),
              count: rule.count,
            }))}
            total={oxlint.errors + oxlint.warnings}
          />
          <CountList
            title="By file"
            rows={oxlint.files.slice(0, TOP_ROWS).map((file) => ({
              label: file.path,
              count: file.count,
            }))}
            total={oxlint.errors + oxlint.warnings}
          />
        </>
      ) : failure ? (
        <p class="measure-failure">{failure}</p>
      ) : (
        <p class="muted">No run yet.</p>
      )}
    </section>
  );
}

function CountList({
  title,
  rows,
  total,
}: {
  title: string;
  rows: Array<{ label: string; count: number }>;
  total: number;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div class="measure-list">
      <h3 class="kind-heading">
        {title}
        <span class="kind-count">{formatInt(total)} total</span>
      </h3>
      <ul class="bars">
        {rows.map((row) => (
          <li key={row.label} class="bar-row bar-row-findings">
            <span class="bar-label mono" title={row.label}>
              {row.label}
            </span>
            <span class="bar-track">
              <span
                class="bar-fill bar-fill-findings"
                style={{ width: `${Math.max(0.5, (row.count / max) * 100)}%` }}
              />
            </span>
            <span class="bar-value">{formatInt(row.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  threshold,
}: {
  label: string;
  value: string;
  note?: string;
  threshold?: number | null;
}): JSX.Element {
  return (
    <div class="measure-figure">
      <p class="tile-label">{label}</p>
      <p class="tile-value">{value}</p>
      {note ? (
        <p class="tile-note">
          {note}
          {threshold !== undefined && threshold !== null
            ? ` · threshold ${Math.round(threshold * 100)}%`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

function percent(hit: number, found: number): string {
  if (found === 0) return "—";
  return `${((hit / found) * 100).toFixed(1)}%`;
}

type HistoryKey = "lines" | "functions" | "errors" | "warnings";

const MINI = { width: 320, height: 64, top: 6, bottom: 6, left: 2, right: 2 };

/**
 * A small step chart of the runs inside the range, two series in the
 * card's own gray and ink so it never borrows the prod and test colors.
 */
function MiniHistory({
  history,
  series,
  format,
  unit,
}: {
  history: MeasureHistoryPoint[];
  series: Array<{ key: HistoryKey; label: string }>;
  format: (value: number) => string;
  unit: "percent" | "count";
}): JSX.Element | null {
  const points = history.filter((point) =>
    series.some((entry) => point[entry.key] !== null),
  );
  if (points.length < 2) {
    return (
      <p class="measure-history-note">
        {points.length === 0
          ? "No run in this range."
          : "One run in this range. A second run starts the history."}
      </p>
    );
  }
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const times = points.map((point) => Date.parse(point.at));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const values = points.flatMap((point) =>
    series.map((entry) => point[entry.key]).filter((value) => value !== null),
  );
  // Air above and below, so a flat series never lies on the baseline.
  const floor = unit === "percent" ? Math.min(...values) : 0;
  const ceiling = Math.max(...values);
  const air = (ceiling - floor || (unit === "percent" ? 0.01 : 1)) * 0.15;
  const low = unit === "percent" ? floor - air : 0;
  const high = ceiling + air;
  const span = high - low;
  const plotWidth = MINI.width - MINI.left - MINI.right;
  const plotHeight = MINI.height - MINI.top - MINI.bottom;
  const x = (time: number): number =>
    MINI.left +
    (t1 === t0 ? plotWidth / 2 : ((time - t0) / (t1 - t0)) * plotWidth);
  const y = (value: number): number =>
    MINI.top + plotHeight - ((value - low) / span) * plotHeight;
  const path = (key: HistoryKey): string => {
    let d = "";
    for (const point of points) {
      const value = point[key];
      if (value === null) continue;
      const px = x(Date.parse(point.at)).toFixed(1);
      const py = y(value).toFixed(1);
      d += d === "" ? `M${px} ${py}` : `H${px}V${py}`;
    }
    return d;
  };
  return (
    <div class="measure-history">
      <svg
        class="mini-svg"
        viewBox={`0 0 ${MINI.width} ${MINI.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${points.length} runs from ${formatDateTime(t0)} to ${formatDateTime(t1)}`}
      >
        <line
          class="chart-grid"
          x1={MINI.left}
          x2={MINI.width - MINI.right}
          y1={MINI.top + plotHeight}
          y2={MINI.top + plotHeight}
        />
        {series.map((entry, index) => (
          <path
            key={entry.key}
            class={`mini-line mini-line-${index}`}
            d={path(entry.key)}
          />
        ))}
      </svg>
      <dl class="mini-legend">
        {series.map((entry, index) => {
          const from = first[entry.key];
          const to = last[entry.key];
          return (
            <div key={entry.key} class="mini-legend-row">
              <dt>
                <span
                  class={`series-key mini-key-${index}`}
                  aria-hidden="true"
                />
                {entry.label}
              </dt>
              <dd>
                {to === null ? "—" : format(to)}
                {from !== null && to !== null ? (
                  <span class="muted">
                    {" "}
                    {unit === "percent"
                      ? `(${to - from >= 0 ? "+" : "−"}${(Math.abs(to - from) * 100).toFixed(1)} pts)`
                      : `(${formatSigned(to - from)})`}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
