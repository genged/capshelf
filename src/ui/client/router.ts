/**
 * Hash routes, so the page needs no server route table and a reload keeps
 * the place. `#/status/<project>/<item>`, `#/shelf/<repo>/<ref>`, and
 * `#/machine`; every segment is URI-encoded.
 */
import { useEffect, useState } from "preact/hooks";

export type Route =
  | { view: "status"; project: string | null; item: string | null }
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
        : ["status", route.project, route.item];
  const encoded: string[] = [];
  for (const segment of segments) {
    if (segment === null || segment === undefined) break;
    encoded.push(encodeURIComponent(segment));
  }
  return `#/${encoded.join("/")}`;
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = (next: Route): void => {
    const hash = routeHash(next);
    if (window.location.hash === hash) {
      setRoute(next);
      return;
    }
    window.location.hash = hash;
  };
  return [route, navigate];
}
