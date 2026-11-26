/**
 * Ported fzf FuzzyMatchV1 (junegunn/fzf `src/algo/algo.go`) rather than
 * depending on the stale npm port; V1 over V2 because shelves are tiny, and
 * extended-search operators are omitted to keep one query language.
 */

/** Order matters: it must match the spec's character class order. */
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

/** Favor word boundaries without letting distant acronym matches dominate. */
const BONUS_BOUNDARY = SCORE_MATCH / 2;
const BONUS_NON_WORD = SCORE_MATCH / 2;
const BONUS_CAMEL_123 = BONUS_BOUNDARY + SCORE_GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION);
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2;
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1;

export interface FuzzyMatch {
  score: number;
  /**
   * Indices count code points, not UTF-16 units, so an emoji is one position;
   * renderers must walk by code point too.
   */
  positions: number[];
}

export { splitTerms as fuzzyTerms } from "./search-core";

export function isCaseSensitive(pattern: string): boolean {
  return pattern !== pattern.toLowerCase();
}

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

  let patternIndex = 0;
  let start = -1;
  let end = -1;
  for (const [index, char] of hay.entries()) {
    // SAFETY: patternIndex < needle.length because the loop breaks on reaching
    // it.
    if (fold(char) !== fold(needle[patternIndex] as string)) continue;
    if (start < 0) start = index;
    patternIndex++;
    if (patternIndex === needle.length) {
      end = index + 1;
      break;
    }
  }
  if (start < 0 || end < 0) return null;

  patternIndex--;
  for (let index = end - 1; index >= start; index--) {
    // SAFETY: pass 1 guarantees 0 <= start < end <= hay.length, and
    // patternIndex >= 0 because the loop breaks below zero.
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

  // Index 0 counts as a word boundary, matching the spec's whitespace initial
  // class outside path mode.
  let previousClass = CHAR_WHITE;
  if (start > 0) {
    // SAFETY: pass 1 found the match inside text, so text[start - 1] is in
    // range.
    previousClass = charClassOf(text[start - 1] as string);
  }

  for (let index = start; index < end; index++) {
    // SAFETY: end is one past a match inside text, so text[index] is in range.
    const char = text[index] as string;
    const charClass = charClassOf(char);
    // SAFETY: end is one past the last pattern character's match, so
    // patternIndex < pattern.length on every iteration.
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
        // Every character in a chunk gets at least BONUS_CONSECUTIVE so that
        // "foobar" beats "foo-bar" on "foob".
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
 * Classes earn boundary bonuses, so an ASCII-only test would treat every
 * Cyrillic or CJK character as a non-word boundary and inflate scores.
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
