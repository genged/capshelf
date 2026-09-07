import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { LocHistory } from "../shared/types";
import { Icon } from "./icons";

export function TopBar({
  history,
  refreshing,
  refreshedAt,
  onRefresh,
}: {
  history: LocHistory | null;
  refreshing: boolean;
  refreshedAt: Date | null;
  onRefresh: () => void;
}): JSX.Element {
  const relative = useRelativeTime(refreshedAt);
  return (
    <header class="top-bar">
      <a class="brand" href="#/" aria-label="Capshelf lines of code">
        <img class="brand-mark" src="/logo.png" alt="" width="26" height="34" />
        <span class="brand-name">Capshelf</span>
      </a>
      <div class="context">
        <span class="context-host">Lines of code</span>
        {history ? (
          <>
            <span class="context-repo" title={history.repo}>
              <span class="context-sep" aria-hidden="true">
                ·{" "}
              </span>
              <span class="mono">{history.display}</span>
            </span>
            <span class="context-sep" aria-hidden="true">
              ·
            </span>
            <span>
              <span class="mono">{history.branch}</span>
              {history.head ? (
                <>
                  {" @ "}
                  <span class="mono">{history.head}</span>
                </>
              ) : null}
            </span>
          </>
        ) : (
          <>
            <span class="context-sep" aria-hidden="true">
              ·
            </span>
            <span class="muted">Reading git history…</span>
          </>
        )}
      </div>
      <div class="refresh">
        <button
          type="button"
          class="button refresh-button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          <Icon name="refresh" />
          <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
        </button>
        <span class="refresh-time" aria-live="polite">
          {refreshedAt
            ? `Read ${formatClock(refreshedAt)}${
                relative === "just now" ? "" : ` · ${relative}`
              }`
            : refreshing
              ? "Reading every commit…"
              : ""}
        </span>
      </div>
    </header>
  );
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function useRelativeTime(date: Date | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  if (date === null) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}
