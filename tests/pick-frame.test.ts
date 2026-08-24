import { describe, expect, test } from "bun:test";
import {
  GUTTER_WIDTH,
  MARKED,
  bodyBudget,
  PLAIN_PALETTE,
  POINTER,
  UNMARKED,
  renderLegend,
  renderPickBody,
  renderRows,
  renderSearchLine,
  renderTabBar,
  visibleWindow,
} from "../src/pick-frame";
import type { PickFrame, PickPalette } from "../src/pick-frame";
import type { PickRow, RankedPickRow } from "../src/pick-core";
import { pickTabs } from "../src/pick-tabs";

function row(ref: string, extra: Partial<PickRow> = {}): PickRow {
  const [kind = "skills", ...rest] = ref.split("/");
  return {
    ref,
    kind: kind as PickRow["kind"],
    name: rest.join("/"),
    tags: [],
    installed: false,
    ...extra,
  };
}

const ranked = (r: PickRow, positions: number[] = []): RankedPickRow => ({
  row: r,
  score: 0,
  positions,
});

/** A palette that marks each role, so styling is assertable as text. */
const MARKUP: PickPalette = {
  accent: (t) => `<a>${t}</a>`,
  dim: (t) => `<d>${t}</d>`,
  disabled: (t) => `<x>${t}</x>`,
};

const SHELF = [
  row("bundles/review-kit", { kind: "bundles", detail: "1 skills" }),
  row("skills/code-review"),
  row("skills/security-review", { description: "Find flaws" }),
  row("mcp/github", { kind: "mcp", installed: true }),
];

function frame(overrides: Partial<PickFrame> = {}): PickFrame {
  return {
    tabs: pickTabs(SHELF),
    activeTab: 0,
    query: "",
    rows: SHELF.map((r) => ranked(r)),
    cursor: 0,
    marked: new Set<string>(),
    height: 10,
    palette: PLAIN_PALETTE,
    ...overrides,
  };
}

describe("renderTabBar", () => {
  const tabs = pickTabs(SHELF);

  test("lists every tab separated by a rule", () => {
    expect(renderTabBar(tabs, 0, PLAIN_PALETTE)[0]).toBe(
      "All │ bundles │ skills │ mcp",
    );
  });

  test("accents the active tab and dims the rest", () => {
    expect(renderTabBar(tabs, 2, MARKUP)[0]).toBe(
      "<d>All</d> │ <d>bundles</d> │ <a>skills</a> │ <d>mcp</d>",
    );
  });

  test("underlines the active tab at the right column", () => {
    // Measured from unstyled widths: an escape sequence has no width, so
    // measuring the styled string would put the rule in the wrong place.
    const [bar, rule] = renderTabBar(tabs, 2, PLAIN_PALETTE);
    expect((rule as string).indexOf("━")).toBe(
      (bar as string).indexOf("skills"),
    );
    expect((rule as string).trim().length).toBe("skills".length);
  });

  test("the rule stays correct when the bar is styled", () => {
    const [, rule] = renderTabBar(tabs, 2, MARKUP);
    expect((rule as string).indexOf("━")).toBe("All │ bundles │ ".length);
  });

  test("no tabs draws nothing", () => {
    expect(renderTabBar([], 0, PLAIN_PALETTE)).toEqual([]);
  });
});

describe("renderSearchLine", () => {
  test("shows the query with a caret and the counts", () => {
    expect(renderSearchLine("rev", 2, 7, PLAIN_PALETTE)).toBe(
      "Search: rev█   2 of 7",
    );
  });

  test("an empty query still draws the caret", () => {
    expect(renderSearchLine("", 7, 7, PLAIN_PALETTE)).toContain("Search: █");
  });
});

describe("renderRows", () => {
  test("groups under kind headings on the All tab with no query", () => {
    const lines = renderRows(frame());
    expect(lines.filter((l) => l === "bundles").length).toBe(1);
    expect(lines.filter((l) => l === "skills").length).toBe(1);
  });

  test("drops headings once a query is typed", () => {
    // Headings would split the ranking and bury the best match mid-list.
    const lines = renderRows(frame({ query: "rev" }));
    expect(lines.some((l) => l.trim() === "skills")).toBe(false);
  });

  test("drops headings on a single-kind tab", () => {
    const lines = renderRows(
      frame({ activeTab: 2, rows: [ranked(row("skills/code-review"))] }),
    );
    expect(lines.some((l) => l.trim() === "skills")).toBe(false);
  });

  test("points at the cursor row and only that row", () => {
    const lines = renderRows(frame({ query: "x", cursor: 1 }));
    expect(lines.filter((l) => l.startsWith(POINTER)).length).toBe(1);
    expect(lines[1]).toStartWith(POINTER);
  });

  test("draws the hint only for the focused row", () => {
    // Every row carrying its description would push the refs apart and turn
    // the list into prose.
    const rows = [ranked(SHELF[2] as PickRow), ranked(SHELF[1] as PickRow)];
    const focused = renderRows(frame({ query: "x", rows, cursor: 0 }));
    expect(focused[0]).toContain("Find flaws");
    const unfocused = renderRows(frame({ query: "x", rows, cursor: 1 }));
    expect(unfocused[0]).not.toContain("Find flaws");
  });

  test("marks a marked row", () => {
    const lines = renderRows(
      frame({ query: "x", marked: new Set(["skills/code-review"]) }),
    );
    expect(lines.find((l) => l.includes("code-review"))).toContain(MARKED);
  });

  test("an installed row is styled disabled and never marked", () => {
    const lines = renderRows(
      frame({
        query: "x",
        rows: [ranked(SHELF[3] as PickRow)],
        palette: MARKUP,
        marked: new Set(["mcp/github"]),
      }),
    );
    expect(lines[0]).toContain(`<x>${UNMARKED}</x>`);
    expect(lines[0]).toContain("<x>mcp/github</x>");
    expect(lines[0]).not.toContain(MARKED);
  });

  test("highlights the matched characters of the ref", () => {
    const lines = renderRows(
      frame({
        query: "rev",
        rows: [ranked(row("skills/code-review"), [12, 13, 14])],
        palette: MARKUP,
      }),
    );
    expect(lines[0]).toContain("<a>rev</a>");
  });

  test("the pointer column is reserved on every row, so boxes align", () => {
    // A one-cell pointer put the marker hard against the checkbox and the two
    // rendered as a single blob.
    const lines = renderRows(frame({ query: "x", cursor: 1 }));
    const boxAt = lines.map((line) => line.indexOf(UNMARKED));
    expect(new Set(boxAt.filter((index) => index >= 0)).size).toBe(1);
    expect(POINTER.length).toBe(2);
  });

  test("the marker is not a triangle", () => {
    // The checkboxes are round. Unicode's right-pointing triangles come in a
    // small size and a full size, and neither is drawn to the same vertical
    // metrics as the checkbox, so neither sits level beside it.
    expect(POINTER.trimEnd()).toBe("❯");
  });

  test("no row carries trailing blanks", () => {
    // Padding every row to the longest ref aligned a single hint against
    // nothing and left the rest with invisible trailing space.
    for (const line of renderRows(frame({ query: "x", cursor: 1 }))) {
      expect(line).toBe(line.trimEnd());
    }
  });

  test("the hint follows its own ref rather than a shared column", () => {
    const rows = [ranked(SHELF[2] as PickRow), ranked(SHELF[1] as PickRow)];
    const [focused] = renderRows(frame({ query: "x", rows, cursor: 0 }));
    expect(focused).toBe(
      `${POINTER}${UNMARKED} skills/security-review  Find flaws`,
    );
  });

  test("a row is kept inside the terminal width", () => {
    // A row wider than the terminal wraps, and the redraw then counts one line
    // where two were drawn, so the frame walks up the screen.
    for (const columns of [80, 60, 44, 34]) {
      for (const line of renderRows(frame({ columns, cursor: 2 }))) {
        expect(line.length + GUTTER_WIDTH).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("a ref too long for the terminal is shortened, not wrapped", () => {
    const long = row(`skills/${"x".repeat(60)}`);
    const [line] = renderRows(
      frame({ query: "x", rows: [ranked(long)], cursor: -1, columns: 40 }),
    );
    expect((line as string).length + GUTTER_WIDTH).toBeLessThanOrEqual(40);
    expect(line).toContain("…");
  });

  test("a hint with no room left is dropped rather than stubbed", () => {
    const [line] = renderRows(
      frame({
        query: "x",
        rows: [ranked(SHELF[2] as PickRow)],
        cursor: 0,
        columns: 34,
      }),
    );
    expect(line).not.toContain("Find flaws");
    expect((line as string).length + GUTTER_WIDTH).toBeLessThanOrEqual(34);
  });

  test("a heading is never the last line of the window", () => {
    // A heading labels the rows under it, so one at the bottom edge labels
    // nothing and reads as a group with no members.
    const rows = [
      ranked(row("skills/a")),
      ranked(row("skills/b")),
      ranked(row("mcp/c", { kind: "mcp" })),
    ];
    for (const height of [2, 3, 4]) {
      const lines = renderRows(frame({ rows, cursor: 0, height, query: "" }));
      expect(lines.at(-1)).not.toBe("mcp");
      expect(lines.at(-1)).not.toBe("skills");
    }
  });

  test("headings count against the height budget", () => {
    // Windowing the rows and inserting headings afterwards spent more lines
    // than `height` allows: on the grouped All view a budget of 10 could draw
    // as many as 17 lines and push the frame past a 24-row terminal.
    const many = [
      ...Array.from({ length: 6 }, (_, i) => ranked(row(`skills/s-${i}`))),
      ...Array.from({ length: 6 }, (_, i) =>
        ranked(row(`mcp/m-${i}`, { kind: "mcp" })),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        ranked(row(`settings/x-${i}`, { kind: "settings" })),
      ),
    ];
    for (const height of [3, 5, 10]) {
      const lines = renderRows(
        frame({ rows: many, cursor: 0, height, query: "" }),
      );
      expect(lines.length).toBeLessThanOrEqual(height);
    }
  });

  test("keeps the cursor row visible even when headings push it down", () => {
    const many = [
      ...Array.from({ length: 6 }, (_, i) => ranked(row(`skills/s-${i}`))),
      ...Array.from({ length: 6 }, (_, i) =>
        ranked(row(`mcp/m-${i}`, { kind: "mcp" })),
      ),
    ];
    const lines = renderRows(
      frame({ rows: many, cursor: 11, height: 5, query: "" }),
    );
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.some((l) => l.includes("mcp/m-5"))).toBe(true);
    expect(lines.filter((l) => l.startsWith(POINTER)).length).toBe(1);
  });

  test("windows a long list around the cursor", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      ranked(row(`skills/item-${String(i).padStart(2, "0")}`)),
    );
    const lines = renderRows(
      frame({ query: "x", rows: many, cursor: 30, height: 5 }),
    );
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes("item-30"))).toBe(true);
  });
});

describe("visibleWindow", () => {
  test("shows everything when the list fits", () => {
    expect(visibleWindow(4, 0, 10)).toEqual({ start: 0, end: 4 });
  });

  test("keeps the cursor inside the window", () => {
    const { start, end } = visibleWindow(40, 30, 5);
    expect(start).toBeLessThanOrEqual(30);
    expect(end).toBeGreaterThan(30);
    expect(end - start).toBe(5);
  });

  test("does not scroll past either end", () => {
    expect(visibleWindow(40, 0, 5)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(40, 39, 5)).toEqual({ start: 35, end: 40 });
  });

  test("an empty list or no height draws nothing", () => {
    expect(visibleWindow(0, 0, 5)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(10, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("renderPickBody", () => {
  test("assembles the bar, the search line, the rows, and the legend", () => {
    const lines = renderPickBody(frame());
    expect(lines[0]).toContain("All");
    expect(lines.some((l) => l.startsWith("Search:"))).toBe(true);
    expect(lines.some((l) => l.includes("bundles/review-kit"))).toBe(true);
    expect(lines.at(-1)).toBe(renderLegend(PLAIN_PALETTE));
  });

  test("counts against the active tab's total, not the whole shelf", () => {
    // The count read `6 of 1` when the row list and the tab disagreed.
    const lines = renderPickBody(
      frame({
        activeTab: 2,
        rows: [ranked(row("skills/code-review"))],
        query: "code",
      }),
    );
    expect(lines.find((l) => l.startsWith("Search:"))).toContain("1 of 2");
  });

  test("says so when nothing matches", () => {
    const lines = renderPickBody(frame({ query: "zzzz", rows: [] }));
    expect(lines.some((l) => l === "no matches")).toBe(true);
  });

  test("the legend names every key the picker binds", () => {
    const legend = renderLegend(PLAIN_PALETTE);
    for (const key of ["←/→", "↑/↓", "tab", "enter", "esc"]) {
      expect(legend).toContain(key);
    }
  });

  test("the legend drops words rather than wrapping", () => {
    for (const columns of [80, 60, 44, 30]) {
      const legend = renderLegend(PLAIN_PALETTE, bodyBudget(columns));
      expect(legend.length + GUTTER_WIDTH).toBeLessThanOrEqual(columns);
      expect(legend).toContain("enter");
    }
  });

  test("the tab bar compacts rather than wrapping", () => {
    const tabs = pickTabs(SHELF);
    const lines = renderTabBar(tabs, 2, PLAIN_PALETTE, bodyBudget(24));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skills");
    // Which of how many, since the other names no longer fit.
    expect(lines[0]).toContain("(3/4)");
    expect((lines[0] as string).length + GUTTER_WIDTH).toBeLessThanOrEqual(24);
  });

  test("a bar that fits keeps every name and its underline", () => {
    const lines = renderTabBar(
      pickTabs(SHELF),
      2,
      PLAIN_PALETTE,
      bodyBudget(100),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("bundles");
  });

  test("the whole frame fits the terminal at any width", () => {
    for (const columns of [100, 80, 60, 44, 34]) {
      for (const line of renderPickBody(frame({ columns }))) {
        expect(line.length + GUTTER_WIDTH).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("a query the user keeps typing does not widen the frame", () => {
    // The query is the one string in the frame that grows without limit, so
    // the search line is the one that overflows if nothing bounds it.
    for (const columns of [100, 80, 60, 44, 34]) {
      const long = frame({ columns, query: "a".repeat(120) });
      for (const line of renderPickBody(long)) {
        expect(line.length + GUTTER_WIDTH).toBeLessThanOrEqual(columns);
      }
    }
  });

  test("a truncated query keeps its tail, where the caret is", () => {
    const line = renderSearchLine("start-middle-end", 1, 1, PLAIN_PALETTE, 20);
    expect(line).toContain("█");
    expect(line).toContain("end");
    expect(line).not.toContain("start");
    expect(line.length).toBeLessThanOrEqual(20);
  });
});
