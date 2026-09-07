/**
 * Two step lines on one axis. A count changes at a commit and holds until
 * the next, so the line steps. There is no area wash: the axis does not
 * start at zero, so a fill would overstate the size of a change. The
 * crosshair snaps to the nearest commit,
 * one tooltip lists both series, the legend toggles a series without
 * repainting the other, and a drag across the plot zooms into that span.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Point,
  type Range,
  type Slice,
  commitTime,
  formatDateTime,
  formatInt,
  formatSigned,
  nearestIndex,
  seriesPoints,
  timeTicks,
  valueDomain,
} from "../shared/series";
import type { LocCommit, SeriesId } from "../shared/types";
import { SERIES_LABEL, SeriesKey } from "./Tiles";

const SERIES: readonly SeriesId[] = ["prod", "test"];
const WIDE_MARGIN = { top: 18, right: 96, bottom: 32, left: 64 };
const NARROW_MARGIN = { top: 18, right: 80, bottom: 32, left: 54 };
const PLOT_HEIGHT = 300;
const DRAG_MIN_PX = 6;
const LABEL_GAP = 16;
const TOOLTIP_WIDTH = 260;

export function LocChart({
  slice,
  range,
  hidden,
  activeSha,
  onActive,
  onToggle,
  onZoom,
}: {
  slice: Slice;
  range: Range;
  hidden: ReadonlySet<SeriesId>;
  activeSha: string | null;
  onActive: (sha: string | null) => void;
  onToggle: (series: SeriesId) => void;
  onZoom: (range: Range) => void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0) setWidth(Math.round(box.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const MARGIN = width < 600 ? NARROW_MARGIN : WIDE_MARGIN;
  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotRight = MARGIN.left + plotWidth;
  const plotBottom = MARGIN.top + PLOT_HEIGHT;
  const height = plotBottom + MARGIN.bottom;

  const commits = slice.inside;
  const times = useMemo(() => commits.map(commitTime), [commits]);
  const visible = SERIES.filter((series) => !hidden.has(series));
  const points = useMemo<Record<SeriesId, Point[]>>(
    () => ({
      prod: seriesPoints(slice, range, "prod"),
      test: seriesPoints(slice, range, "test"),
    }),
    [slice, range],
  );
  const domain = useMemo(
    () =>
      valueDomain(
        visible.flatMap((series) => points[series].map((point) => point.value)),
      ),
    [points, visible.join()],
  );

  const x = (time: number): number =>
    MARGIN.left +
    ((time - range.start) / Math.max(1, range.end - range.start)) * plotWidth;
  const y = (value: number): number =>
    MARGIN.top +
    PLOT_HEIGHT -
    ((value - domain.min) / Math.max(1e-9, domain.max - domain.min)) *
      PLOT_HEIGHT;
  const timeAt = (px: number): number =>
    range.start +
    (Math.min(Math.max(px - MARGIN.left, 0), plotWidth) / plotWidth) *
      (range.end - range.start);

  const xTicks = timeTicks(range, Math.max(2, Math.floor(plotWidth / 88)));
  const activeIndex =
    activeSha === null
      ? -1
      : commits.findIndex((commit) => commit.sha === activeSha);
  const active = activeIndex >= 0 ? (commits[activeIndex] ?? null) : null;
  const previous =
    activeIndex > 0 ? (commits[activeIndex - 1] ?? null) : slice.carried;

  const endLabels = placeEndLabels(
    visible.map((series) => {
      const last = points[series][points[series].length - 1];
      return { series, value: last?.value ?? 0, y: y(last?.value ?? 0) };
    }),
  );

  const localX = (event: JSX.TargetedPointerEvent<SVGRectElement>): number => {
    const box = host.current?.getBoundingClientRect();
    return event.clientX - (box?.left ?? 0);
  };
  const pick = (px: number): void => {
    if (times.length === 0) return;
    const index = nearestIndex(times, timeAt(px));
    const sha = commits[index]?.sha ?? null;
    if (sha !== activeSha) onActive(sha);
  };
  const onPointerMove = (
    event: JSX.TargetedPointerEvent<SVGRectElement>,
  ): void => {
    const px = localX(event);
    if (drag) setDrag({ from: drag.from, to: px });
    pick(px);
  };
  const onPointerDown = (
    event: JSX.TargetedPointerEvent<SVGRectElement>,
  ): void => {
    if (event.button !== 0) return;
    const px = localX(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: px, to: px });
  };
  const onPointerUp = (
    event: JSX.TargetedPointerEvent<SVGRectElement>,
  ): void => {
    if (!drag) return;
    const to = localX(event);
    setDrag(null);
    if (Math.abs(to - drag.from) < DRAG_MIN_PX) return;
    const start = timeAt(Math.min(drag.from, to));
    const end = timeAt(Math.max(drag.from, to));
    if (end - start >= 60_000) onZoom({ start, end });
  };
  const onKeyDown = (
    event: JSX.TargetedKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === "Escape") {
      if (drag) setDrag(null);
      else onActive(null);
      return;
    }
    if (commits.length === 0) return;
    const last = commits.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(last, activeIndex + 1);
    else if (event.key === "ArrowLeft")
      next = activeIndex < 0 ? last : Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    onActive(commits[next]?.sha ?? null);
  };

  const lastValues = visible
    .map((series) => {
      const last = points[series][points[series].length - 1];
      return last ? `${SERIES_LABEL[series]} ${formatInt(last.value)}` : null;
    })
    .filter((entry) => entry !== null)
    .join(", ");

  const tooltipLeft =
    active === null
      ? 0
      : x(commitTime(active)) + 14 + TOOLTIP_WIDTH > width
        ? x(commitTime(active)) - 14 - TOOLTIP_WIDTH
        : x(commitTime(active)) + 14;

  return (
    <figure class="figure">
      <figcaption class="figure-head">
        <div class="figure-titles">
          <h2 class="figure-title">Lines over time</h2>
          <p class="figure-lead">
            Non-blank lines at each commit. Hover for a commit, drag to zoom,
            arrow keys move between commits.
          </p>
        </div>
        <fieldset class="legend">
          <legend class="visually-hidden">Series</legend>
          {SERIES.map((series) => {
            const shown = !hidden.has(series);
            const lastOne = shown && visible.length === 1;
            return (
              <button
                key={series}
                type="button"
                class={`legend-item${shown ? "" : " is-hidden"}`}
                aria-pressed={shown}
                disabled={lastOne}
                title={
                  lastOne
                    ? "One series stays visible"
                    : shown
                      ? `Hide ${SERIES_LABEL[series]}`
                      : `Show ${SERIES_LABEL[series]}`
                }
                onClick={() => onToggle(series)}
              >
                <SeriesKey series={series} />
                <span>{SERIES_LABEL[series]}</span>
              </button>
            );
          })}
        </fieldset>
      </figcaption>
      <div
        ref={host}
        class="chart"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart takes arrow keys, Home, End, and Escape
        tabIndex={0}
        role="application"
        aria-label={`Lines over time. ${lastValues || "No lines yet"} at the end of the range. Arrow keys move between commits.`}
        onKeyDown={onKeyDown}
        onBlur={() => onActive(null)}
      >
        <svg class="chart-svg" width={width} height={height} aria-hidden="true">
          <defs>
            <clipPath id="plot-clip">
              <rect
                x={MARGIN.left}
                y={MARGIN.top - 2}
                width={plotWidth}
                height={PLOT_HEIGHT + 4}
              />
            </clipPath>
          </defs>
          {domain.ticks.map((tick) => (
            <g key={tick}>
              <line
                class="chart-grid"
                x1={MARGIN.left}
                x2={plotRight}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                class="chart-tick"
                x={MARGIN.left - 10}
                y={y(tick)}
                text-anchor="end"
                dominant-baseline="middle"
              >
                {formatInt(tick)}
              </text>
            </g>
          ))}
          <line
            class="chart-axis"
            x1={MARGIN.left}
            x2={plotRight}
            y1={plotBottom}
            y2={plotBottom}
          />
          {xTicks.map((tick) => (
            <g key={tick.time}>
              <line
                class="chart-axis"
                x1={x(tick.time)}
                x2={x(tick.time)}
                y1={plotBottom}
                y2={plotBottom + 4}
              />
              <text
                class="chart-tick"
                x={x(tick.time)}
                y={plotBottom + 18}
                text-anchor="middle"
              >
                {tick.label}
              </text>
            </g>
          ))}
          <g clip-path="url(#plot-clip)">
            {visible.map((series) => (
              <path
                key={`line-${series}`}
                class={`chart-line chart-line-${series}`}
                d={stepPath(points[series], x, y)}
              />
            ))}
            {drag ? (
              <rect
                class="chart-select"
                x={Math.min(drag.from, drag.to)}
                y={MARGIN.top}
                width={Math.abs(drag.to - drag.from)}
                height={PLOT_HEIGHT}
              />
            ) : null}
            {active ? (
              <line
                class="chart-crosshair"
                x1={x(commitTime(active))}
                x2={x(commitTime(active))}
                y1={MARGIN.top}
                y2={plotBottom}
              />
            ) : null}
          </g>
          {visible.map((series) => {
            const last = lastCommitPoint(points[series]);
            return last ? (
              <circle
                key={`end-${series}`}
                class={`chart-dot chart-dot-${series}`}
                cx={x(last.time)}
                cy={y(last.value)}
                r={4}
              />
            ) : null;
          })}
          {active
            ? visible.map((series) => (
                <circle
                  key={`active-${series}`}
                  class={`chart-dot chart-dot-${series} is-active`}
                  cx={x(commitTime(active))}
                  cy={y(active[series])}
                  r={5}
                />
              ))
            : null}
          {endLabels.map((label) => (
            <g key={`label-${label.series}`}>
              {label.moved ? (
                <line
                  class="chart-leader"
                  x1={plotRight + 6}
                  x2={plotRight + 14}
                  y1={label.y}
                  y2={label.labelY}
                />
              ) : null}
              <text
                class="chart-end-value"
                x={plotRight + 18}
                y={label.labelY}
                dominant-baseline="middle"
              >
                {formatInt(label.value)}
                <tspan class="chart-end-name">
                  {" "}
                  {SERIES_LABEL[label.series].toLowerCase()}
                </tspan>
              </text>
            </g>
          ))}
          <rect
            class="chart-overlay"
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotWidth}
            height={PLOT_HEIGHT}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
            onPointerLeave={() => {
              if (!drag) onActive(null);
            }}
          />
        </svg>
        {active ? (
          <Tooltip
            commit={active}
            previous={previous}
            visible={visible}
            left={tooltipLeft}
            top={MARGIN.top + 6}
          />
        ) : null}
      </div>
      <p class="visually-hidden" aria-live="polite">
        {active
          ? `${formatDateTime(commitTime(active))}, ${active.subject}. ${visible
              .map(
                (series) =>
                  `${SERIES_LABEL[series]} ${formatInt(active[series])}`,
              )
              .join(", ")}.`
          : ""}
      </p>
      {commits.length === 0 ? (
        <p class="chart-note">
          {slice.carried
            ? "No commit lands in this range. The lines hold the last count before it."
            : "No commit exists before or inside this range."}
        </p>
      ) : null}
    </figure>
  );
}

function Tooltip({
  commit,
  previous,
  visible,
  left,
  top,
}: {
  commit: LocCommit;
  previous: LocCommit | null;
  visible: SeriesId[];
  left: number;
  top: number;
}): JSX.Element {
  return (
    <div class="tooltip" style={{ left: `${left}px`, top: `${top}px` }}>
      <p class="tooltip-time mono">{formatDateTime(commitTime(commit))}</p>
      <p class="tooltip-commit">
        <span class="mono">{commit.short}</span> {commit.subject}
      </p>
      <ul class="tooltip-rows">
        {visible.map((series) => (
          <li key={series} class="tooltip-row">
            <SeriesKey series={series} />
            <strong class="tooltip-value">{formatInt(commit[series])}</strong>
            <span class="tooltip-delta">
              {previous ? formatSigned(commit[series] - previous[series]) : ""}
            </span>
            <span class="tooltip-name">
              {SERIES_LABEL[series].toLowerCase()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function stepPath(
  points: Point[],
  x: (time: number) => number,
  y: (value: number) => number,
): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${x(first.time).toFixed(1)} ${y(first.value).toFixed(1)}`;
  for (const point of points.slice(1)) {
    d += `H${x(point.time).toFixed(1)}V${y(point.value).toFixed(1)}`;
  }
  return d;
}

function lastCommitPoint(points: Point[]): Point | null {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (point?.commit) return point;
  }
  return null;
}

interface EndLabel {
  series: SeriesId;
  value: number;
  y: number;
  labelY: number;
  moved: boolean;
}

/** Two labels that would overlap are pushed apart and get leader lines. */
function placeEndLabels(
  labels: Array<{ series: SeriesId; value: number; y: number }>,
): EndLabel[] {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  const placed: EndLabel[] = [];
  for (const label of sorted) {
    const previous = placed[placed.length - 1];
    let labelY = label.y;
    if (previous && labelY - previous.labelY < LABEL_GAP) {
      labelY = previous.labelY + LABEL_GAP;
    }
    placed.push({ ...label, labelY, moved: labelY !== label.y });
  }
  if (placed.length === 2 && placed[1]?.moved) {
    const shift = (placed[1].labelY - placed[1].y) / 2;
    const first = placed[0];
    if (first) {
      first.labelY -= shift;
      first.moved = true;
    }
    placed[1].labelY -= shift;
  }
  return placed;
}
