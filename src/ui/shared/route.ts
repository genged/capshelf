/**
 * Hash routes, so the page needs no server route table and a reload keeps
 * the place. `#/status/<project>/<item>`, `#/findings/<project>/<item>`,
 * `#/shelf/<repo>/<ref>`, `#/shelf/<repo>/rollouts/<ref>`,
 * `#/shelf/<repo>/coverage`, and `#/machine/<entry>`; every segment is
 * URI-encoded.
 * An encoded ref always holds `%2F`, so a section name never reads as one.
 * Pure: the hook that follows the location lives in the client router.
 */

export type ShelfSection = "items" | "rollouts" | "coverage";

export type Route =
  | { view: "status"; project: string | null; item: string | null }
  | { view: "findings"; project: string | null; item: string | null }
  | {
      view: "shelf";
      repo: string | null;
      section: ShelfSection;
      ref: string | null;
    }
  /** `entry` is a `machineEntryKey` from the view model. */
  | { view: "machine"; entry: string | null };

function isSection(value: string | undefined): value is ShelfSection {
  return value === "items" || value === "rollouts" || value === "coverage";
}

const OVERVIEW: Route = { view: "status", project: null, item: null };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  let parts: string[];
  try {
    parts = raw
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  } catch {
    // A hand-edited link can hold a bad percent escape, and
    // `decodeURIComponent` throws a URIError for it. The route is parsed
    // during render, so a throw would leave a blank page. The overview opens
    // instead.
    return OVERVIEW;
  }
  if (parts[0] === "shelf") {
    const section = parts[2];
    return isSection(section)
      ? {
          view: "shelf",
          repo: parts[1] ?? null,
          section,
          ref: parts[3] ?? null,
        }
      : {
          view: "shelf",
          repo: parts[1] ?? null,
          section: "items",
          ref: parts[2] ?? null,
        };
  }
  if (parts[0] === "machine") {
    return { view: "machine", entry: parts[1] ?? null };
  }
  if (parts[0] === "findings") {
    return {
      view: "findings",
      project: parts[1] ?? null,
      item: parts[2] ?? null,
    };
  }
  return {
    view: "status",
    project: parts[0] === "status" ? (parts[1] ?? null) : null,
    item: parts[0] === "status" ? (parts[2] ?? null) : null,
  };
}

/**
 * Item ids that earlier releases of the dashboard put in a status route for
 * user-level skills: the aggregate `user-skills` row, and the per-skill
 * `user/<surface>/<name>`. User-level skills now live in This machine, and
 * the per-skill id carries the path (`user/<surface>:<path>`), so an old link
 * opens This machine instead of a project overview.
 */
export function isLegacyUserSkillItem(item: string): boolean {
  return item === "user-skills" || /^user\/(claude|codex)\/[^:]+$/.test(item);
}

export function routeHash(route: Route): string {
  const segments =
    route.view === "shelf"
      ? route.section === "items"
        ? ["shelf", route.repo, route.ref]
        : ["shelf", route.repo, route.section, route.ref]
      : route.view === "machine"
        ? ["machine", route.entry]
        : [route.view, route.project, route.item];
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === null || segment === undefined) break;
    encoded.push(encodeURIComponent(segment));
  }
  return `#/${encoded.join("/")}`;
}
