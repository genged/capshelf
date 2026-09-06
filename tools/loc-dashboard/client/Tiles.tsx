/**
 * The four figures the range resolves to. Each value is the count at the
 * range end; each delta is against the count at the range start.
 */
import type { JSX } from "preact";
import {
  type Summary,
  formatInt,
  formatPercent,
  formatRatio,
  formatSigned,
  formatSignedRatio,
  ratio,
} from "../shared/series";
import type { SeriesId } from "../shared/types";

export const SERIES_LABEL: Record<SeriesId, string> = {
  prod: "Prod",
  test: "Test",
};

export function SeriesKey({ series }: { series: SeriesId }): JSX.Element {
  return <span class={`series-key series-key-${series}`} aria-hidden="true" />;
}

export function Tiles({ summary }: { summary: Summary }): JSX.Element {
  const end = summary.end;
  const start = summary.start;
  const perDay = summary.commits / summary.days;
  return (
    <div class="tiles">
      {(["prod", "test"] as const).map((series) => (
        <Tile
          key={series}
          label={`${SERIES_LABEL[series]} lines`}
          series={series}
          value={end ? formatInt(end[series]) : "—"}
          note={
            end && start
              ? `${formatSigned(end[series] - start[series])}${
                  start[series] > 0
                    ? ` (${formatPercent(end[series] - start[series], start[series])})`
                    : ""
                } in range`
              : end
                ? "No commit before this range"
                : "No commit yet"
          }
        />
      ))}
      <Tile
        label="Test to prod"
        value={end ? formatRatio(ratio(end)) : "—"}
        note={
          end && start && ratio(end) !== null && ratio(start) !== null
            ? `${formatSignedRatio((ratio(end) ?? 0) - (ratio(start) ?? 0))} in range · test lines per prod line`
            : "test lines per prod line"
        }
      />
      <Tile
        label="Commits"
        value={formatInt(summary.commits)}
        note={
          summary.commits === 0
            ? "None in this range"
            : `${perDay >= 10 ? perDay.toFixed(0) : perDay.toFixed(1)} per day over ${summary.days} ${summary.days === 1 ? "day" : "days"}`
        }
      />
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  series,
}: {
  label: string;
  value: string;
  note: string;
  series?: SeriesId;
}): JSX.Element {
  return (
    <section class="tile" aria-label={label}>
      <h2 class="tile-label">
        {series ? <SeriesKey series={series} /> : null}
        {label}
      </h2>
      <p class="tile-value">{value}</p>
      <p class="tile-note">{note}</p>
    </section>
  );
}
