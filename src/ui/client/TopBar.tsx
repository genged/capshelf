import type { Route } from "./router";
import { formatClock, useRelativeTime } from "./common";
import { Icon } from "./icons";

export type TopView = "projects" | "shelf" | "machine";

/** Which top-level view a route belongs to. */
export function topView(route: Route): TopView {
  if (route.view === "shelf") return "shelf";
  if (route.view === "machine") return "machine";
  return "projects";
}

/**
 * Brand, the three views, the jump field, the read-only badge, and refresh.
 * The host and the shelf live in the rail now, so the bar stays short.
 */
export function TopBar({
  view,
  projectsHref,
  shelfHref,
  refreshing,
  refreshedAt,
  onRefresh,
  onJump,
  onHelp,
}: {
  view: TopView;
  projectsHref: string;
  shelfHref: string;
  refreshing: boolean;
  refreshedAt: Date | null;
  onRefresh: () => void;
  onJump?: (() => void) | undefined;
  onHelp: () => void;
}): preact.JSX.Element {
  const relative = useRelativeTime(refreshedAt);
  const link = (
    id: TopView,
    href: string,
    label: string,
  ): preact.JSX.Element => (
    <a
      class="nav-link"
      href={href}
      aria-current={view === id ? "page" : undefined}
    >
      {label}
    </a>
  );
  return (
    <header class="top-bar">
      <a class="brand" href="#/" aria-label="Capshelf projects">
        <img class="brand-mark" src="/logo.png" alt="" width="26" height="34" />
        <span class="brand-name">Capshelf</span>
      </a>
      <nav class="nav" aria-label="Views">
        {link("projects", projectsHref, "Projects")}
        {link("shelf", shelfHref, "Shelf")}
        {link("machine", "#/machine", "This machine")}
      </nav>
      <span class="top-spacer" />
      {onJump ? (
        <button
          type="button"
          class="jump-trigger"
          onClick={onJump}
          aria-label="Jump to an item or project"
          aria-keyshortcuts="/"
        >
          <Icon name="search" />
          <span class="jump-trigger-text">Jump to an item or project</span>
          <kbd>/</kbd>
        </button>
      ) : null}
      <span
        class="ro-badge"
        title="capshelf ui shows commands. Run them in a terminal in the project."
      >
        Read-only
      </span>
      <div class="refresh">
        <span class="refresh-time" aria-live="polite">
          {refreshedAt
            ? relative === "just now"
              ? `Updated ${formatClock(refreshedAt)}`
              : `Updated ${relative}`
            : refreshing
              ? "Reading every project…"
              : ""}
        </span>
        <button
          type="button"
          class="icon-button refresh-button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          aria-label={refreshing ? "Refreshing" : "Refresh every project"}
          title="Refresh (r)"
        >
          <Icon name="refresh" />
        </button>
      </div>
      <button
        type="button"
        class="icon-button help-toggle"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        onClick={onHelp}
      >
        <Icon name="keyboard" />
      </button>
    </header>
  );
}
