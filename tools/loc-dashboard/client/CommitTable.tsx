/**
 * The chart's table twin: every commit in the range, newest first, with
 * the counts and the change each one made. Hovering a row moves the chart's
 * crosshair to that commit.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  type Slice,
  commitTime,
  formatDateTime,
  formatInt,
  formatSigned,
} from "../shared/series";
import type { LocCommit, SeriesId } from "../shared/types";
import { SERIES_LABEL } from "./Tiles";

const PAGE = 40;

interface Row {
  commit: LocCommit;
  previous: LocCommit | null;
}

export function CommitTable({
  slice,
  hidden,
  activeSha,
  onActive,
}: {
  slice: Slice;
  hidden: ReadonlySet<SeriesId>;
  activeSha: string | null;
  onActive: (sha: string | null) => void;
}): JSX.Element {
  const [all, setAll] = useState(false);
  const rows: Row[] = slice.inside
    .map((commit, index) => ({
      commit,
      previous: index > 0 ? (slice.inside[index - 1] ?? null) : slice.carried,
    }))
    .reverse();
  const shown = all ? rows : rows.slice(0, PAGE);
  const visible = (["prod", "test"] as const).filter(
    (series) => !hidden.has(series),
  );
  return (
    <section class="card commits">
      <div class="card-head">
        <h2 class="card-title">
          Commits in range
          <span class="kind-count"> {formatInt(rows.length)}</span>
        </h2>
        <p class="card-lead">
          Newest first. Each change is against the commit before it.
        </p>
      </div>
      {rows.length === 0 ? (
        <p class="muted commits-empty">No commit lands in this range.</p>
      ) : (
        <div class="table-scroll">
          <table class="commits-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Commit</th>
                <th scope="col" class="col-subject">
                  Subject
                </th>
                {visible.map((series) => (
                  <th key={series} scope="col" class="col-num" colSpan={2}>
                    {SERIES_LABEL[series]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody onPointerLeave={() => onActive(null)}>
              {shown.map(({ commit, previous }) => (
                <tr
                  key={commit.sha}
                  class={commit.sha === activeSha ? "is-active" : ""}
                  onPointerEnter={() => onActive(commit.sha)}
                >
                  <td class="mono col-date">
                    {formatDateTime(commitTime(commit))}
                  </td>
                  <td class="mono">{commit.short}</td>
                  <td class="col-subject">{commit.subject}</td>
                  {visible.map((series) => (
                    <CountCells
                      key={series}
                      value={commit[series]}
                      previous={previous ? previous[series] : null}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > PAGE ? (
        <p class="commits-more">
          <button
            type="button"
            class="link-button"
            onClick={() => setAll((value) => !value)}
          >
            {all
              ? `Show the newest ${PAGE}`
              : `Show all ${formatInt(rows.length)}`}
          </button>
        </p>
      ) : null}
    </section>
  );
}

function CountCells({
  value,
  previous,
}: {
  value: number;
  previous: number | null;
}): JSX.Element {
  const delta = previous === null ? null : value - previous;
  return (
    <>
      <td class="col-num">{formatInt(value)}</td>
      <td class={`col-num col-delta${delta === 0 ? " is-zero" : ""}`}>
        {delta === null ? "" : formatSigned(delta)}
      </td>
    </>
  );
}
