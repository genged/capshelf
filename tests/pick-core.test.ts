import { describe, expect, test } from "bun:test";
import {
  createPickFinder,
  highlightRef,
  orderPickRows,
  pickRowHint,
  sanitizeDisplayText,
  scorePickRow,
} from "../src/pick-core";
import type { PickRow } from "../src/pick-core";

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

const SHELF: PickRow[] = [
  row("skills/security-review", {
    tags: ["security"],
    description: "Review a diff for vulnerabilities",
  }),
  row("skills/code-review", { tags: ["review"] }),
  row("mcp/postgres-local", { kind: "mcp", tags: ["db"] }),
  row("bundles/review-kit", {
    kind: "bundles",
    detail: "2 skills",
    tags: ["review"],
  }),
  row("settings/strict-hooks", { kind: "settings" }),
];

describe("orderPickRows", () => {
  test("puts bundles first, then kind order, then name", () => {
    expect(orderPickRows(SHELF).map((r) => r.ref)).toEqual([
      "bundles/review-kit",
      "skills/code-review",
      "skills/security-review",
      "settings/strict-hooks",
      "mcp/postgres-local",
    ]);
  });

  test("does not mutate its input", () => {
    const input = [...SHELF];
    orderPickRows(input);
    expect(input.map((r) => r.ref)).toEqual(SHELF.map((r) => r.ref));
  });
});

describe("scorePickRow field weighting", () => {
  const scoreOf = (query: string, r: PickRow): number =>
    scorePickRow(query, r)?.score ?? -1;

  test("a name match outranks a description match on the same query", () => {
    // The regression this weighting exists for. fzf scores a match after
    // whitespace (bonus 10) above one after a delimiter (bonus 9), so with the
    // fields joined into one line, `your work` inside a description beat
    // `you` at the start of `skills/youtube-summarizer` by exactly 4 points.
    const named = row("skills/youtube-summarizer");
    const described = row("skills/simple-english", {
      description: "Use for answering the user and explaining your work.",
    });
    expect(scoreOf("you", named)).toBeGreaterThan(scoreOf("you", described));
  });

  test("a tag match outranks a description match", () => {
    const tagged = row("skills/a", { tags: ["security"] });
    const described = row("skills/b", { description: "security" });
    expect(scoreOf("security", tagged)).toBeGreaterThan(
      scoreOf("security", described),
    );
  });

  test("a name match outranks a tag match", () => {
    const named = row("skills/security");
    const tagged = row("skills/b", { tags: ["security"] });
    expect(scoreOf("security", named)).toBeGreaterThan(
      scoreOf("security", tagged),
    );
  });

  test("a description-only match is still found", () => {
    // Weighting must not make lower-weight fields unsearchable.
    expect(scorePickRow("vulnerabilities", SHELF[0] as PickRow)).not.toBeNull();
  });

  test("terms may be won by different fields", () => {
    const r = row("skills/security-review", {
      description: "Find vulnerabilities in a diff",
    });
    expect(scorePickRow("security vulner", r)).not.toBeNull();
  });

  test("a term matching no field disqualifies the row", () => {
    expect(scorePickRow("security zzzz", SHELF[0] as PickRow)).toBeNull();
  });

  test("only ref matches produce highlight positions", () => {
    const r = row("skills/security-review", { description: "vulnerabilities" });
    expect(scorePickRow("vulner", r)?.positions).toEqual([]);
    expect((scorePickRow("sec", r)?.positions.length ?? 0) > 0).toBe(true);
  });

  test("an empty query scores every row zero", () => {
    expect(scorePickRow("  ", SHELF[0] as PickRow)).toEqual({
      score: 0,
      positions: [],
    });
  });
});

describe("createPickFinder", () => {
  const finder = createPickFinder(SHELF);

  test("an empty query returns the whole catalog in browse order", () => {
    // Not ranked. Every row scores 0, and sorting those by the tiebreaker
    // would replace the kind grouping with an order by ref length.
    expect(finder.find("").map((entry) => entry.row.ref)).toEqual(
      orderPickRows(SHELF).map((r) => r.ref),
    );
  });

  test("a whitespace-only query is treated as empty", () => {
    expect(finder.find("   ").length).toBe(SHELF.length);
  });

  test("finds an item by a subsequence of its ref", () => {
    expect(finder.find("secrev")[0]?.row.ref).toBe("skills/security-review");
  });

  test("finds an item through its description", () => {
    const found = finder.find("vulner");
    expect(found.map((entry) => entry.row.ref)).toEqual([
      "skills/security-review",
    ]);
  });

  test("finds an item through its tags", () => {
    expect(finder.find("db")[0]?.row.ref).toBe("mcp/postgres-local");
  });

  test("every term must match", () => {
    expect(finder.find("review postgres")).toEqual([]);
  });

  test("drops rows the query does not match", () => {
    expect(finder.find("zzzz")).toEqual([]);
  });

  test("highlight positions stay inside the ref", () => {
    for (const entry of finder.find("review")) {
      for (const position of entry.positions) {
        expect(position).toBeLessThan(entry.row.ref.length);
      }
    }
  });

  test("a description-only match highlights nothing", () => {
    expect(finder.find("vulner")[0]?.positions).toEqual([]);
  });

  test("ties break toward the shorter ref", () => {
    // `review` matches the trailing word of both refs identically, so the
    // scores tie and only the length criterion separates them. This is the
    // same rule that resolves the algo.go `ff` example.
    const refs = finder.find("review").map((entry) => entry.row.ref);
    expect(refs.indexOf("skills/code-review")).toBeLessThan(
      refs.indexOf("skills/security-review"),
    );
  });

  test("ranking is stable across repeated queries", () => {
    expect(finder.find("rev").map((e) => e.row.ref)).toEqual(
      finder.find("rev").map((e) => e.row.ref),
    );
  });
});

describe("highlightRef", () => {
  const mark = (matched: string): string => `[${matched}]`;

  test("wraps each run of matched characters once", () => {
    expect(
      highlightRef("skills/security-review", [7, 8, 9, 16, 17, 18], mark),
    ).toBe("skills/[sec]urity-[rev]iew");
  });

  test("no positions leaves the ref untouched", () => {
    expect(highlightRef("skills/foo", [], mark)).toBe("skills/foo");
  });

  test("a run that reaches the end is closed", () => {
    expect(highlightRef("abc", [1, 2], mark)).toBe("a[bc]");
  });

  test("a run at the start is wrapped", () => {
    expect(highlightRef("abc", [0], mark)).toBe("[a]bc");
  });

  test("every character matched wraps the whole ref", () => {
    expect(highlightRef("abc", [0, 1, 2], mark)).toBe("[abc]");
  });

  test("positions are code points, so an astral character stays whole", () => {
    // Walking UTF-16 units would paint one half of the surrogate pair.
    expect(highlightRef("skills/🎨-design", [7], mark)).toBe(
      "skills/[🎨]-design",
    );
  });

  test("a match after an astral character lands on the right one", () => {
    expect(highlightRef("a🎨bc", [2, 3], mark)).toBe("a🎨[bc]");
  });
});

describe("pickRowHint", () => {
  test("names the installed state first", () => {
    expect(pickRowHint(row("skills/a", { installed: true }))).toBe(
      "already installed",
    );
  });

  test("joins detail and description", () => {
    expect(
      pickRowHint(
        row("bundles/kit", {
          kind: "bundles",
          detail: "2 skills",
          description: "A kit",
        }),
      ),
    ).toBe("2 skills · A kit");
  });

  test("a bare row has no hint", () => {
    expect(pickRowHint(row("skills/a"))).toBeUndefined();
  });
});

describe("sanitizeDisplayText", () => {
  /**
   * A description comes out of a data repo's `.capshelf.yml` or SKILL.md
   * frontmatter, so its bytes are chosen by whoever writes the shelf. The
   * picker paints it into a live frame, and `capshelf init` draws the focused
   * row's hint before the user selects anything.
   */
  const ESC = String.fromCharCode(27);

  test("replaces an escape sequence so it cannot reach the terminal", () => {
    const hostile = `Review a diff${ESC}[2J${ESC}[H spoofed`;
    const clean = sanitizeDisplayText(hostile);
    expect(clean).not.toContain(ESC);
    expect(clean).toContain("Review a diff");
  });

  test("replaces an OSC sequence", () => {
    expect(
      sanitizeDisplayText(`x${ESC}]52;c;cGF5bG9hZA==\u0007y`),
    ).not.toContain(ESC);
  });

  test("replaces carriage returns and newlines, which would break the frame", () => {
    expect(sanitizeDisplayText("one\r\ntwo")).toBe("one  two");
  });

  test("replaces C1 controls", () => {
    expect(sanitizeDisplayText(`a${String.fromCharCode(0x9b)}b`)).toBe("a b");
  });

  test("leaves ordinary text, including non-ASCII, alone", () => {
    expect(sanitizeDisplayText("Rewiew ünïcode · ok")).toBe(
      "Rewiew ünïcode · ok",
    );
  });

  test("a row hint is sanitized, not just the raw helper", () => {
    const hint = pickRowHint(
      row("skills/a", { description: `evil${ESC}[31m red` }),
    );
    expect(hint).not.toContain(ESC);
  });
});
