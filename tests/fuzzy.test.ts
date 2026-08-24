import { describe, expect, test } from "bun:test";
import { fuzzyMatchV1, fuzzyTerms, isCaseSensitive } from "../src/fuzzy";

/**
 * The ranking cases below are not invented. Each one is stated in the header
 * comment of `src/algo/algo.go` in junegunn/fzf, the published description
 * this module is ported from, where the preferred string is marked with
 * backticks underneath it. They are the reason a ported algorithm is worth
 * more than a hand-tuned one: the spec ships its own acceptance tests.
 */
describe("fuzzyMatchV1 against the published algo.go examples", () => {
  const scoreOf = (pattern: string, text: string): number => {
    const match = fuzzyMatchV1(pattern, text);
    expect(match).not.toBeNull();
    return (match as { score: number }).score;
  };

  test("prefers more characters at word boundaries", () => {
    // e.g. "fuzzyfinder" vs. "fuzzy-finder" on "ff" -> fuzzy-finder
    expect(scoreOf("ff", "fuzzy-finder")).toBeGreaterThan(
      scoreOf("ff", "fuzzyfinder"),
    );
  });

  test("doubles the bonus when the first pattern character is at a boundary", () => {
    // e.g. "fo-bar" vs. "foob-r" on "br" -> fo-bar
    expect(scoreOf("br", "fo-bar")).toBeGreaterThan(scoreOf("br", "foob-r"));
  });

  test("the gap penalty cancels the boundary bonus past ~8 characters", () => {
    // e.g. "fuzzyfinder" vs. "fuzzy-blurry-finder" on "ff" -> fuzzyfinder.
    //
    // This is an exact tie on score, and that is the documented design: the
    // constants "were chosen that the bonus is cancelled when the gap between
    // the acronyms grows over 8 characters". fzf resolves it with its default
    // --tiebreak=length (man fzf: "Default is length"), which `pick-core.ts`
    // reproduces. Asserting the tie pins the cancellation point; asserting a
    // winner here would silently pass if the scoring drifted either way.
    expect(scoreOf("ff", "fuzzyfinder")).toBe(
      scoreOf("ff", "fuzzy-blurry-finder"),
    );
  });

  test("the consecutive bonus keeps a tight match ahead of a boundary one", () => {
    // e.g. "foobar" vs. "foo-bar" on "foob" -> foobar. Without the consecutive
    // bonus this ranking inverts, which algo.go calls out as the anomaly the
    // bonus exists to correct.
    expect(scoreOf("foob", "foobar")).toBeGreaterThan(
      scoreOf("foob", "foo-bar"),
    );
  });

  test("a chunk's bonus is set by its first character", () => {
    // e.g. "foobar" vs. "out-of-bound" on "oob" -> out-of-bound.
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
    // A forward-only scan would spread `review` across the whole ref, because
    // r, e, v, i, e, w are all available inside "security" and earlier. The
    // backward pass is what recovers the contiguous trailing word.
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
