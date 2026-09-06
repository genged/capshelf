import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  type Range,
  type RangeSelection,
  commitTime,
  parseSelection,
  resolveRange,
  selectionHash,
  sliceHistory,
  summarize,
  toDay,
} from "../shared/series";
import type { LocHistory, SeriesId } from "../shared/types";
import { ApiError, apiGet } from "./api";
import { Breakdown, clearBreakdownCache } from "./Breakdown";
import { CommitTable } from "./CommitTable";
import { LocChart } from "./LocChart";
import { Measures, useMeasures } from "./Measures";
import { RangeBar } from "./RangeBar";
import { SeriesKey, Tiles } from "./Tiles";
import { TopBar } from "./TopBar";

export function Dashboard(): JSX.Element {
  const [history, setHistory] = useState<LocHistory | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [selection, setSelection] = useState<RangeSelection>(() =>
    parseSelection(window.location.hash),
  );
  const [hidden, setHidden] = useState<Set<SeriesId>>(() => new Set());
  const [activeSha, setActiveSha] = useState<string | null>(null);
  const measures = useMeasures();

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const next = await apiGet<LocHistory>("/api/history");
      clearBreakdownCache();
      setHistory(next);
      setError(null);
      setNow(Date.now());
      setRefreshedAt(new Date());
    } catch (reason) {
      setError(
        reason instanceof ApiError ? reason : new ApiError(0, String(reason)),
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onHash = (): void =>
      setSelection(parseSelection(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "r") {
        event.preventDefault();
        void load();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [load]);

  const select = (next: RangeSelection): void => {
    const hash = selectionHash(next);
    if (window.location.hash === hash) setSelection(next);
    else window.location.hash = hash;
  };

  const commits = history?.commits ?? [];
  const firstTime = commits[0] ? commitTime(commits[0]) : null;
  const range = useMemo<Range>(
    () => resolveRange(selection, now, firstTime),
    [selection, now, firstTime],
  );
  const slice = useMemo(() => sliceHistory(commits, range), [commits, range]);
  const summary = useMemo(() => summarize(slice, range), [slice, range]);
  const endCommit = slice.inside[slice.inside.length - 1] ?? slice.carried;

  const toggle = (series: SeriesId): void => {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(series)) next.delete(series);
      else if (next.size === 0) next.add(series);
      return next;
    });
  };

  return (
    <div class="app">
      <TopBar
        history={history}
        refreshing={refreshing}
        refreshedAt={refreshedAt}
        onRefresh={() => void load()}
      />
      {error && history === null ? (
        <main class="page-message">
          <div class="empty-state">
            <h2>The dashboard could not load</h2>
            <p>{error.message}</p>
            {error.hint ? <p class="muted">{error.hint}</p> : null}
            <p>
              <button type="button" class="button" onClick={() => void load()}>
                Try again
              </button>
            </p>
          </div>
        </main>
      ) : history === null ? (
        <main class="page" aria-busy="true">
          <div class="reading" role="status">
            <p>Reading every commit on the branch…</p>
            <p class="muted">
              The first read counts every blob once. Later reads reuse it.
            </p>
          </div>
        </main>
      ) : (
        <main class={`page${refreshing ? " is-refreshing" : ""}`}>
          {error ? (
            <div class="notice notice-warn" role="alert">
              <p>The last refresh failed: {error.message}</p>
            </div>
          ) : null}
          <RangeBar
            selection={selection}
            range={range}
            commits={summary.commits}
            days={summary.days}
            onSelect={select}
          />
          <Tiles summary={summary} />
          <LocChart
            slice={slice}
            range={range}
            hidden={hidden}
            activeSha={activeSha}
            onActive={setActiveSha}
            onToggle={toggle}
            onZoom={(zoom) =>
              select({
                kind: "custom",
                from: toDay(zoom.start),
                to: toDay(zoom.end),
              })
            }
          />
          <Measures
            state={measures.state}
            error={measures.error}
            range={range}
            onRun={measures.run}
          />
          <div class="row">
            <Breakdown
              endSha={endCommit?.sha ?? null}
              startSha={slice.carried?.sha ?? null}
              hidden={hidden}
            />
            <section class="card rules">
              <div class="card-head">
                <h2 class="card-title">What counts</h2>
                <p class="card-lead">
                  A line counts when it is not blank. A file counts when it
                  matches one of these rules at that commit.
                </p>
              </div>
              <ul class="rule-list">
                {history.rules.map((rule) => (
                  <li key={rule.description} class="rule-row">
                    <SeriesKey series={rule.series} />
                    <span class="rule-series">
                      {rule.series === "prod" ? "Prod" : "Test"}
                    </span>
                    <code>{rule.description}</code>
                  </li>
                ))}
              </ul>
              <p class="card-foot">
                Commits follow the first parent of{" "}
                <span class="mono">{history.branch}</span>. Edit{" "}
                <span class="mono">tools/loc-dashboard/rules.ts</span> to change
                the rules.
              </p>
            </section>
          </div>
          <CommitTable
            slice={slice}
            hidden={hidden}
            activeSha={activeSha}
            onActive={setActiveSha}
          />
        </main>
      )}
    </div>
  );
}
