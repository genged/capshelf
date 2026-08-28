/**
 * fzf's FuzzyMatchV1, ported from its published description.
 *
 * Source: `src/algo/algo.go` in junegunn/fzf, whose header comment is the
 * reference description of the algorithm and whose constants carry the
 * reasoning for their values. Ported rather than depended on: the JavaScript
 * port on npm (`fzf`) has not been published since 2023, and this is ~200
 * lines of pure arithmetic with no reason to drift.
 *
 * The algorithm, quoting the spec:
 *
 *     FuzzyMatchV1 finds the first "fuzzy" occurrence of the pattern within
 *     the given text in O(n) time where n is the length of the text. Once the
 *     position of the last character is located, it traverses backwards to see
 *     if there's a shorter substring that matches the pattern.
 *
 *         a_____b___abc__  To find "abc"
 *         *-----*-----*>   1. Forward scan
 *                  <***    2. Backward scan
 *
 * V1, not V2. The spec is explicit that V1 "only sees the first occurrence"
 * and so "is not guaranteed to find the occurrence with the highest score",
 * while V2 is a Smith-Waterman variant that is optimal at O(nm). That trade
 * was written for million-line inputs. A capshelf shelf holds tens of items
 * whose refs are one or two words, where the backward pass already recovers
 * the tight match, so the optimal search buys ranking nobody can perceive for
 * a dynamic-programming table and its bugs. If a shelf ever grows to where
 * this is wrong, V2 is the documented upgrade.
 *
 * Not ported: fzf's extended-search operators (`^prefix`, `suffix$`, `'exact`,
 * `!invert`, `|`). A query is whitespace-separated terms that must all match,
 * as `capshelf search` already defines one, and one query language across the
 * product is worth more than the operators. `fuzzyTerms` splits them here;
 * combining them across an item's fields belongs to `pick-core.ts`, which is
 * what knows the fields apart.
 */

/** Character classes, in the spec's order — the ordering is load-bearing. */
const CHAR_WHITE = 0;
const CHAR_NON_WORD = 1;
const CHAR_DELIMITER = 2;
const CHAR_LOWER = 3;
const CHAR_UPPER = 4;
const CHAR_LETTER = 5;
const CHAR_NUMBER = 6;

const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const NUMBER = /\p{N}/u;
const LETTER = /\p{L}/u;
const WHITE_SPACE = /\p{White_Space}/u;

const DELIMITER_CHARS = "/,:;|";
const WHITE_CHARS = " \t\n\v\f\r\x85\xA0";

const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;

/**
 * "We prefer matches at the beginning of a word, but the bonus should not be
 * too great to prevent the longer acronym matches from always winning over
 * shorter fuzzy matches. The bonus point here was specifically chosen that the
 * bonus is cancelled when the gap between the acronyms grows over 8
 * characters." — algo.go
 */
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NON_WORD = SCORE_MATCH / 2;
/** camelCase and letter123 edges, minus a gap-extension the boundary case pays. */
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
/** Minimum bonus for a character inside a consecutive chunk. */
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
/** The first pattern character carries more intent, so its bonus is doubled. */
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2;
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;

export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches of the same query. */
  score: number;
  /**
   * Indices in the haystack the pattern matched, ascending, counted in code
   * points rather than UTF-16 units.
   *
   * The whole module counts that way. Indexing a JavaScript string directly
   * splits any character outside the basic plane into two halves, which made
   * one emoji report two match positions and let a highlighter paint half a
   * character. A caller that renders these positions must walk the string by
   * code point too.
   */
  positions: number[];
}

/** Split a query the way `capshelf search` does — it is the same function. */
export { splitTerms as fuzzyTerms } from "./search-core";

/**
 * Smart case, as fzf defines it: an all-lowercase pattern matches
 * case-insensitively, and one uppercase character makes the whole pattern
 * case-sensitive.
 */
export function isCaseSensitive(pattern: string): boolean {
  return pattern !== pattern.toLowerCase();
}

/**
 * Match one pattern against one string, or return null when the pattern is not
 * a subsequence of it.
 */
export function fuzzyMatchV1(
  pattern: string,
  text: string,
  caseSensitive = isCaseSensitive(pattern),
): FuzzyMatch | null {
  const needle = [...pattern];
  const hay = [...text];
  if (needle.length === 0) return { score: 0, positions: [] };

  const fold = (char: string): string =>
    caseSensitive ? char : char.toLowerCase();

  // Pass 1: forward, to the earliest index where the pattern can finish.
  let patternIndex = 0;
  let start = -1;
  let end = -1;
  for (let index = 0; index < hay.length; index++) {
    if (fold(hay[index] as string) !== fold(needle[patternIndex] as string)) {
      continue;
    }
    if (start < 0) start = index;
    patternIndex++;
    if (patternIndex === needle.length) {
      end = index + 1;
      break;
    }
  }
  if (start < 0 || end < 0) return null;

  // Pass 2: backward from that end, to the latest start that still holds the
  // whole pattern. This is what turns a match spread across `s`kills/s`e`
  // `c`urity into the tight `sec` inside "security".
  patternIndex--;
  for (let index = end - 1; index >= start; index--) {
    if (fold(hay[index] as string) !== fold(needle[patternIndex] as string)) {
      continue;
    }
    patternIndex--;
    if (patternIndex < 0) {
      start = index;
      break;
    }
  }

  return calculateScore(needle, hay, start, end, caseSensitive);
}

/**
 * Score the matched window, per `calculateScore` in the spec.
 *
 * A gap inside the window costs `SCORE_GAP_START` for the first skipped
 * character and `SCORE_GAP_EXTENSION` for each one after — an affine gap
 * penalty, the same shape Smith-Waterman alignment uses.
 */
function calculateScore(
  pattern: readonly string[],
  text: readonly string[],
  start: number,
  end: number,
  caseSensitive: boolean,
): FuzzyMatch {
  let patternIndex = 0;
  let score = 0;
  let inGap = false;
  let consecutive = 0;
  let firstBonus = 0;
  const positions: number[] = [];

  // The spec seeds this with `initialCharClass`, which is whitespace outside
  // path mode: index 0 of a string counts as a word boundary.
  let previousClass = CHAR_WHITE;
  if (start > 0) previousClass = charClassOf(text[start - 1] as string);

  for (let index = start; index < end; index++) {
    const char = text[index] as string;
    const charClass = charClassOf(char);
    const matches = caseSensitive
      ? char === pattern[patternIndex]
      : char.toLowerCase() === (pattern[patternIndex] as string).toLowerCase();

    if (matches) {
      positions.push(index);
      score += SCORE_MATCH;
      let bonus = bonusFor(previousClass, charClass);
      if (consecutive === 0) {
        firstBonus = bonus;
      } else {
        // Breaking a consecutive chunk: a strong boundary can raise the
        // chunk's base bonus, and every character in a chunk gets at least
        // BONUS_CONSECUTIVE so that "foobar" beats "foo-bar" on "foob".
        if (bonus >= BONUS_BOUNDARY && bonus > firstBonus) firstBonus = bonus;
        bonus = Math.max(bonus, firstBonus, BONUS_CONSECUTIVE);
      }
      score += patternIndex === 0 ? bonus * BONUS_FIRST_CHAR_MULTIPLIER : bonus;
      inGap = false;
      consecutive++;
      patternIndex++;
    } else {
      score += inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      inGap = true;
      consecutive = 0;
      firstBonus = 0;
    }
    previousClass = charClass;
  }
  return { score, positions };
}

/**
 * Classify one character, in the order the spec's own `charClassOfNonAscii`
 * uses.
 *
 * The classes earn the boundary bonuses, so an ASCII-only test does not merely
 * ignore other scripts, it misreads them. Every Cyrillic or CJK character
 * counted as a non-word character, so each one looked like a word boundary and
 * inflated the score of any text that used them.
 */
function charClassOf(char: string): number {
  if (char >= "a" && char <= "z") return CHAR_LOWER;
  if (char >= "A" && char <= "Z") return CHAR_UPPER;
  if (char >= "0" && char <= "9") return CHAR_NUMBER;
  if (WHITE_CHARS.includes(char)) return CHAR_WHITE;
  if (DELIMITER_CHARS.includes(char)) return CHAR_DELIMITER;
  if ((char.codePointAt(0) ?? 0) < 0x80) return CHAR_NON_WORD;
  if (LOWER.test(char)) return CHAR_LOWER;
  if (UPPER.test(char)) return CHAR_UPPER;
  if (NUMBER.test(char)) return CHAR_NUMBER;
  if (LETTER.test(char)) return CHAR_LETTER;
  if (WHITE_SPACE.test(char)) return CHAR_WHITE;
  return CHAR_NON_WORD;
}

function bonusFor(previousClass: number, charClass: number): number {
  if (charClass >= CHAR_NON_WORD) {
    if (previousClass === CHAR_WHITE) return BONUS_BOUNDARY_WHITE;
    if (previousClass === CHAR_DELIMITER) return BONUS_BOUNDARY_DELIMITER;
    if (previousClass === CHAR_NON_WORD) return BONUS_BOUNDARY;
  }
  if (
    (previousClass === CHAR_LOWER && charClass === CHAR_UPPER) ||
    (previousClass !== CHAR_NUMBER && charClass === CHAR_NUMBER)
  ) {
    return BONUS_CAMEL_123;
  }
  if (charClass === CHAR_NON_WORD || charClass === CHAR_DELIMITER) {
    return BONUS_NON_WORD;
  }
  if (charClass === CHAR_WHITE) return BONUS_BOUNDARY_WHITE;
  return 0;
}
