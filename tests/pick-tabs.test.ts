import { describe, expect, test } from "bun:test";
import { parsePickKind } from "../src/pick-core";
import {
  pickTabs,
  rowsForTab,
  showsGroupHeadings,
  stepTab,
} from "../src/pick-tabs";
import type { PickRow } from "../src/pick-core";

function row(ref: string, installed = false): PickRow {
  const [kind = "skills", ...rest] = ref.split("/");
  return {
    ref,
    kind: parsePickKind(kind),
    name: rest.join("/"),
    tags: [],
    installed,
  };
}

const SHELF: PickRow[] = [
  row("skills/code-review"),
  row("skills/security-review"),
  row("mcp/github"),
  row("bundles/review-kit"),
];

describe("pickTabs", () => {
  test("puts All first, then kinds in canonical order", () => {
    expect(pickTabs(SHELF).map((tab) => tab.key)).toEqual([
      "all",
      "bundles",
      "skills",
      "mcp",
    ]);
  });

  test("counts the rows each tab shows", () => {
    const counts = Object.fromEntries(
      pickTabs(SHELF).map((tab) => [tab.key, tab.count]),
    );
    expect(counts).toEqual({ all: 4, bundles: 1, skills: 2, mcp: 1 });
  });

  test("omits a kind with no rows", () => {
    // A tab that shows nothing is a dead stop when cycling.
    expect(pickTabs(SHELF).map((tab) => tab.key)).not.toContain("settings");
  });

  test("an empty shelf still has the All tab", () => {
    expect(pickTabs([]).map((tab) => tab.key)).toEqual(["all"]);
  });
});

describe("rowsForTab", () => {
  test("All shows everything", () => {
    expect(rowsForTab(SHELF, "all")).toHaveLength(4);
  });

  test("a kind tab shows only that kind", () => {
    expect(rowsForTab(SHELF, "skills").map((r) => r.ref)).toEqual([
      "skills/code-review",
      "skills/security-review",
    ]);
  });

  test("does not mutate the shelf", () => {
    const before = SHELF.map((r) => r.ref);
    rowsForTab(SHELF, "all").pop();
    expect(SHELF.map((r) => r.ref)).toEqual(before);
  });
});

describe("stepTab", () => {
  test("moves forward and back", () => {
    expect(stepTab(4, 0, 1)).toBe(1);
    expect(stepTab(4, 2, -1)).toBe(1);
  });

  test("wraps at both ends", () => {
    // The bar is short, and someone holding an arrow key to survey the shelf
    // should not have to notice which end they are at.
    expect(stepTab(4, 3, 1)).toBe(0);
    expect(stepTab(4, 0, -1)).toBe(3);
  });

  test("a single tab stays put", () => {
    expect(stepTab(1, 0, 1)).toBe(0);
    expect(stepTab(1, 0, -1)).toBe(0);
  });

  test("no tabs is not an error", () => {
    expect(stepTab(0, 0, 1)).toBe(0);
  });
});

describe("showsGroupHeadings", () => {
  test("only the All tab with no query gets headings", () => {
    expect(showsGroupHeadings("all", "")).toBe(true);
    expect(showsGroupHeadings("all", "   ")).toBe(true);
  });

  test("a query drops them, because headings would split the ranking", () => {
    expect(showsGroupHeadings("all", "rev")).toBe(false);
  });

  test("a single-kind tab never gets them", () => {
    // The heading would only repeat the tab.
    expect(showsGroupHeadings("skills", "")).toBe(false);
    expect(showsGroupHeadings("skills", "rev")).toBe(false);
  });
});
