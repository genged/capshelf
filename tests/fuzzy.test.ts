import { describe, expect, test } from "bun:test";
import { fuzzyMatchV1, fuzzyTerms, isCaseSensitive } from "../src/fuzzy";

/**
 * Ranking cases come from the header of fzf's `src/algo/algo.go`, which this
 * module ports, so the spec supplies its own acceptance tests.
 */
describe("fuzzyMatchV1 against the published algo.go examples", () => {
  const scoreOf = (pattern: string, text: string): number => {
    const match = fuzzyMatchV1(pattern, text);
    expect(match).not.toBeNull();
    return match!.score;
  };

  test("prefers more characters at word boundaries", () => {
    expect(scoreOf("ff", "fuzzy-finder")).toBeGreaterThan(
      scoreOf("ff", "fuzzyfinder"),
    );
  });

  test("doubles the bonus when the first pattern character is at a boundary", () => {
    expect(scoreOf("br", "fo-bar")).toBeGreaterThan(scoreOf("br", "foob-r"));
  });

  test("the gap penalty cancels the boundary bonus past ~8 characters", () => {
    // Exact tie is the documented design (bonus cancels past 8 chars) and fzf
    // breaks it by length; asserting a winner would pass if scoring drifted.
    expect(scoreOf("ff", "fuzzyfinder")).toBe(
      scoreOf("ff", "fuzzy-blurry-finder"),
    );
  });

  test("the consecutive bonus keeps a tight match ahead of a boundary one", () => {
    expect(scoreOf("foob", "foobar")).toBeGreaterThan(
      scoreOf("foob", "foo-bar"),
    );
  });

  test("a chunk's bonus is set by its first character", () => {
    expect(scoreOf("oob", "out-of-bound")).toBeGreaterThan(
      scoreOf("oob", "foobar"),
    );
  });
});

describe("fuzzyMatchV1", () => {
  test("matches a subsequence with gaps", () => {
    const match = fuzzyMatchV1("secrev", "skills/security-review");
    expect(match).not.toBeNull();
    expect(match?.positions).toEqual([7, 8, 9, 11, 17, 18]);
  });

  test("returns null when a character is missing", () => {
    expect(fuzzyMatchV1("zzz", "skills/security-review")).toBeNull();
  });

  test("returns null when the characters are present out of order", () => {
    expect(fuzzyMatchV1("ba", "abc")).toBeNull();
  });

  test("an empty pattern matches everything with no positions", () => {
    expect(fuzzyMatchV1("", "anything")).toEqual({ score: 0, positions: [] });
  });

  test("the backward pass tightens the match to the trailing word", () => {
    // A forward-only scan would spread `review` across the ref; the backward
    // pass recovers the contiguous trailing word.
    const match = fuzzyMatchV1("review", "skills/security-review");
    expect(match?.positions).toEqual([16, 17, 18, 19, 20, 21]);
  });

  test("positions are indices into the haystack, not the pattern", () => {
    const text = "skills/code-review";
    const match = fuzzyMatchV1("code", text);
    expect(match?.positions.map((index) => text[index]).join("")).toBe("code");
  });
});

describe("smart case", () => {
  test("a lowercase pattern is case-insensitive", () => {
    expect(isCaseSensitive("review")).toBe(false);
    expect(fuzzyMatchV1("review", "skills/Security-REVIEW")).not.toBeNull();
  });

  test("one uppercase character makes the pattern case-sensitive", () => {
    expect(isCaseSensitive("Review")).toBe(true);
    expect(fuzzyMatchV1("Review", "skills/security-review")).toBeNull();
    expect(fuzzyMatchV1("Review", "skills/security-Review")).not.toBeNull();
  });
});

describe("fuzzyTerms", () => {
  test("splits on whitespace and drops empties", () => {
    expect(fuzzyTerms("  sec   rev ")).toEqual(["sec", "rev"]);
  });

  test("an empty query has no terms", () => {
    expect(fuzzyTerms("   ")).toEqual([]);
  });
});

describe("Unicode", () => {
  /**
   * Positions count code points because indexing a JS string walks UTF-16
   * halves, splitting an emoji in two.
   */
  test("a character outside the basic plane is one position, not two", () => {
    const match = fuzzyMatchV1("🎨", "skills/🎨-design");
    expect(match?.positions).toHaveLength(1);
  });

  test("positions index code points, so they address whole characters", () => {
    const text = "skills/🎨-design";
    const match = fuzzyMatchV1("design", text);
    const chars = [...text];
    expect(match?.positions.map((index) => chars[index]).join("")).toBe(
      "design",
    );
  });

  test("a letter is not a word boundary, whatever its script", () => {
    // Non-ASCII letters must keep their word classes; treating them as non-word
    // characters makes each look like a separator and inflates scores.
    const midWord = fuzzyMatchV1("б", "Аб")?.score ?? -1;
    const afterDelimiter = fuzzyMatchV1("б", "-б")?.score ?? -1;
    expect(afterDelimiter).toBeGreaterThan(midWord);
  });

  test("case folding works beyond ASCII", () => {
    expect(fuzzyMatchV1("ä", "Ärger")).not.toBeNull();
    expect(fuzzyMatchV1("жук", "ЖУК")).not.toBeNull();
  });

  test("smart case applies to non-ASCII, so a capital still narrows", () => {
    expect(isCaseSensitive("жук")).toBe(false);
    expect(isCaseSensitive("Жук")).toBe(true);
    expect(fuzzyMatchV1("ЖУК", "жук")).toBeNull();
  });

  test("a CJK query matches CJK text", () => {
    const match = fuzzyMatchV1("設定", "設定ファイル");
    expect(match?.positions).toEqual([0, 1]);
  });
});
