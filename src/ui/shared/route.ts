/**
 * Hash routes, so the page needs no server route table and a reload keeps
 * the place. `#/status/<project>/<item>`, `#/findings/<project>/<item>`,
 * `#/shelf/<repo>/<ref>`, and `#/machine`; every segment is URI-encoded.
 * Pure: the hook that follows the location lives in the client router.
 */

export type Route =
  | { view: "status"; project: string | null; item: string | null }
  | { view: "findings"; project: string | null; item: string | null }
  | { view: "shelf"; repo: string | null; ref: string | null }
  | { view: "machine" };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => decodeURIComponent(part));
  if (parts[0] === "shelf") {
    return { view: "shelf", repo: parts[1] ?? null, ref: parts[2] ?? null };
  }
  if (parts[0] === "machine") {
    return { view: "machine" };
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

export function routeHash(route: Route): string {
  const segments =
    route.view === "shelf"
      ? ["shelf", route.repo, route.ref]
      : route.view === "machine"
        ? ["machine"]
        : [route.view, route.project, route.item];
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === null || segment === undefined) break;
    encoded.push(encodeURIComponent(segment));
  }
  return `#/${encoded.join("/")}`;
}
