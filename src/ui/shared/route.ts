/**
 * An encoded ref always contains `%2F`, so a ref never matches a section name.
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
    // A hand-edited link can hold a bad percent escape that makes
    // `decodeURIComponent` throw during render and blank the page, so fall back
    // to the overview.
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
 * Old dashboard links used these user-skill item ids in status routes; redirect
 * them to This machine.
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
