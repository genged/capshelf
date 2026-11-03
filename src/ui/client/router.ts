/**
 * The hook that follows `window.location.hash`. The route shapes and their
 * parsing live in `../shared/route`, which tests import without Preact.
 */
import { useEffect, useState } from "preact/hooks";
import { parseRoute, type Route, routeHash } from "../shared/route";

export { parseRoute, type Route, routeHash };

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
