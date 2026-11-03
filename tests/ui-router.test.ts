import { describe, expect, test } from "bun:test";
import {
  isLegacyUserSkillItem,
  parseRoute,
  type Route,
  routeHash,
} from "../src/ui/shared/route";

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
    {
      view: "shelf",
      repo: "/home/u/shelf",
      section: "items",
      ref: "skills/quick-review",
    },
    { view: "shelf", repo: "/home/u/shelf", section: "rollouts", ref: null },
    {
      view: "shelf",
      repo: "/home/u/shelf",
      section: "rollouts",
      ref: "skills/quick-review",
    },
    { view: "shelf", repo: "/home/u/shelf", section: "coverage", ref: null },
    { view: "machine", entry: null },
    {
      view: "machine",
      entry: "skill:claude:/home/u/.claude/skills/quick-review",
    },
  ];

  test("old user-level skill ids are recognized, new ones are not", () => {
    expect(isLegacyUserSkillItem("user-skills")).toBe(true);
    expect(isLegacyUserSkillItem("user/claude/quick-review")).toBe(true);
    expect(isLegacyUserSkillItem("user/codex/notes")).toBe(true);
    expect(
      isLegacyUserSkillItem("user/claude:/home/u/.claude/skills/quick-review"),
    ).toBe(false);
    expect(isLegacyUserSkillItem("project/data/skills/quick-review")).toBe(
      false,
    );
  });

  test("an old shelf link without a section still opens the item", () => {
    expect(parseRoute("#/shelf/%2Fs/skills%2Fx")).toEqual({
      view: "shelf",
      repo: "/s",
      section: "items",
      ref: "skills/x",
    });
  });

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
