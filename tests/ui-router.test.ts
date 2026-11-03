import { describe, expect, test } from "bun:test";
import { parseRoute, type Route, routeHash } from "../src/ui/shared/route";

describe("hash routes", () => {
  const routes: Route[] = [
    { view: "status", project: "/home/u/code/app", item: null },
    {
      view: "status",
      project: "/home/u/code/app",
      item: "project/data/skills/quick-review",
    },
    { view: "findings", project: null, item: null },
    {
      view: "findings",
      project: "/home/u/code/app",
      item: "project/data/skills/quick-review",
    },
    { view: "shelf", repo: "/home/u/shelf", ref: "skills/quick-review" },
    { view: "machine" },
  ];

  test("every route survives a round trip through its hash", () => {
    for (const route of routes) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
  });

  test("an empty or unknown hash opens the status view", () => {
    expect(parseRoute("")).toEqual({
      view: "status",
      project: null,
      item: null,
    });
    expect(parseRoute("#/nowhere")).toEqual({
      view: "status",
      project: null,
      item: null,
    });
  });

  test("a slash inside a segment stays inside it", () => {
    const hash = routeHash({
      view: "findings",
      project: "/a/b",
      item: "project/data/skills/x",
    });
    expect(hash).toBe("#/findings/%2Fa%2Fb/project%2Fdata%2Fskills%2Fx");
  });
});
