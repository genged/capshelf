import type { RefObject } from "preact";
import type { UiOverview, UiShelfFacts } from "../shared/api-types";
import { formatClock, useRelativeTime } from "./common";
import { Icon } from "./icons";

export function TopBar({
  overview,
  shelf,
  refreshing,
  refreshedAt,
  onRefresh,
  query,
  onQuery,
  filterRef,
  view,
  onView,
  drawerOpen,
  onToggleDrawer,
  onToggleHelp,
}: {
  overview: UiOverview | null;
  shelf: UiShelfFacts | null;
  refreshing: boolean;
  refreshedAt: Date | null;
  onRefresh: () => void;
  query: string;
  onQuery: (query: string) => void;
  filterRef: RefObject<HTMLInputElement>;
  view: "status" | "shelf";
  onView: (view: "status" | "shelf") => void;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
  onToggleHelp: () => void;
}): preact.JSX.Element {
  const relative = useRelativeTime(refreshedAt);
  const projectCount = overview?.projects.length ?? 0;
  return (
    <header class="top-bar">
      <button
        type="button"
        class="icon-button drawer-toggle"
        aria-label={
          drawerOpen ? "Close the project list" : "Open the project list"
        }
        aria-expanded={drawerOpen}
        onClick={onToggleDrawer}
      >
        <Icon name={drawerOpen ? "close" : "menu"} />
      </button>
      <a class="brand" href="#/" aria-label="Capshelf status">
        <img class="brand-mark" src="/logo.png" alt="" width="26" height="34" />
        <span class="brand-name">Capshelf</span>
      </a>
      <div class="context">
        {overview ? (
          <>
            <span class="context-host">{overview.host}</span>
            {shelf ? (
              <>
                <span class="context-sep" aria-hidden="true">
                  ·
                </span>
                <span class="context-shelf">
                  shelf <span class="mono">{shelf.display}</span>
                  {shelf.headShort ? (
                    <>
                      {" @ "}
                      <span class="mono">{shelf.headShort}</span>
                    </>
                  ) : null}
                  {shelf.clean ? null : (
                    <span class="context-dirty"> · uncommitted changes</span>
                  )}
                </span>
              </>
            ) : null}
            <span class="context-sep" aria-hidden="true">
              ·
            </span>
            <span>
              {projectCount} {projectCount === 1 ? "project" : "projects"}
            </span>
          </>
        ) : (
          <span class="muted">Loading…</span>
        )}
      </div>
      <nav class="view-nav" aria-label="View">
        <button
          type="button"
          class={`view-tab${view === "status" ? " is-active" : ""}`}
          aria-current={view === "status" ? "page" : undefined}
          onClick={() => onView("status")}
        >
          Status
        </button>
        <button
          type="button"
          class={`view-tab${view === "shelf" ? " is-active" : ""}`}
          aria-current={view === "shelf" ? "page" : undefined}
          onClick={() => onView("shelf")}
        >
          Shelf
        </button>
      </nav>
      {view === "status" ? (
        <label class="filter">
          <Icon name="search" />
          <span class="visually-hidden">Filter projects and items</span>
          <input
            ref={filterRef}
            type="search"
            placeholder="Filter projects and items"
            value={query}
            onInput={(event) => onQuery(event.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
        </label>
      ) : (
        <div class="filter-spacer" />
      )}
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
            ? `Refreshed ${formatClock(refreshedAt)}${
                relative === "just now" ? "" : ` · ${relative}`
              }`
            : refreshing
              ? "Reading every project…"
              : ""}
        </span>
      </div>
      <button
        type="button"
        class="icon-button help-toggle"
        aria-label="Keyboard shortcuts"
        onClick={onToggleHelp}
      >
        <Icon name="keyboard" />
      </button>
    </header>
  );
}
