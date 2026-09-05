/**
 * The picker's ranking, kept apart from `pick-core.ts` so the web UI can
 * bundle it for a browser. This module imports only `fuzzy.ts`. The row
 * model, the catalog order, and the terminal strings stay in `pick-core.ts`,
 * which re-exports these names, so its callers do not change.
 */
import { fuzzyMatchV1, fuzzyTerms } from "./fuzzy";

/**
 * Per-field multipliers, and the reason the picker does not match one
 * concatenated line.
 *
 * Joining the ref, tags, and description into a single haystack is what fzf
 * does, and it was wrong here. fzf matches lines where the line *is* the item;
 * these fields are parts of one item and are not equally important. Worse, the
 * concatenation actively inverted the ranking, because fzf scores a match
 * after whitespace higher than one after a delimiter
 * (`bonusBoundaryWhite` 10 against `bonusBoundaryDelimiter` 9). Every word in a
 * description follows a space, while an item's name follows the `/` in its
 * ref. So searching `you` put `skills/simple-english`, which matches `your
 * work` in its description, above `skills/youtube-summarizer`: 88 against 84.
 *
 * Scoring each field on its own and weighting it fixes that, and it restores
 * agreement with `capshelf search`, whose documented weights these are, minus
 * `content`, which the picker does not read.
 */
export const PICK_FIELD_WEIGHTS = {
  ref: 8,
  tags: 4,
  description: 2,
} as const;

export type PickFieldName = keyof typeof PICK_FIELD_WEIGHTS;

/** The fields the ranking reads. Every picker row satisfies it. */
export interface RankableRow {
  ref: string;
  tags: string[];
  description?: string;
}

export interface RankedRow<Row extends RankableRow> {
  row: Row;
  score: number;
  /** Highlight positions inside `row.ref`, ascending. */
  positions: number[];
}

/**
 * Score one row against a whole query, or return null when it does not match.
 *
 * Every whitespace-separated term must match some field, which is the AND rule
 * `capshelf search` already defines. A term scores the best weighted field it
 * hits, and the term scores add. With a ref weight four times the description
 * weight, a name match beats a description match unless the name match is far
 * sloppier — which is the ordering a user expects when they type a name.
 */
export function scorePickRow(
  query: string,
  row: RankableRow,
): { score: number; positions: number[] } | null {
  const terms = fuzzyTerms(query);
  if (terms.length === 0) return { score: 0, positions: [] };

  let total = 0;
  const positions = new Set<number>();
  for (const term of terms) {
    const best = bestFieldForTerm(term, row);
    if (!best) return null;
    total += best.score;
    // Only the ref is rendered in full, so only its positions can be
    // highlighted. A term won by a tag or a description highlights nothing.
    if (best.field === "ref") {
      for (const position of best.positions) positions.add(position);
    }
  }
  return { score: total, positions: [...positions].sort((a, b) => a - b) };
}

function bestFieldForTerm(
  term: string,
  row: RankableRow,
): { field: PickFieldName; score: number; positions: number[] } | null {
  let best: {
    field: PickFieldName;
    score: number;
    positions: number[];
  } | null = null;
  const consider = (field: PickFieldName, text: string): void => {
    const match = fuzzyMatchV1(term, text);
    if (!match) return;
    const weighted = match.score * PICK_FIELD_WEIGHTS[field];
    if (best && best.score >= weighted) return;
    best = { field, score: weighted, positions: match.positions };
  };

  consider("ref", row.ref);
  for (const tag of row.tags) consider("tags", tag);
  if (row.description !== undefined) consider("description", row.description);
  return best;
}

/**
 * Score descending, then the shorter ref, then the ref itself.
 *
 * The length tiebreak is fzf's own default (`man fzf`: "Default is length"),
 * and it is load-bearing rather than cosmetic. The algorithm's published
 * example — `fuzzyfinder` preferred over `fuzzy-blurry-finder` on `ff` — is an
 * exact score tie that only the length criterion resolves. Measuring the ref
 * rather than the whole haystack keeps a long description from deciding it,
 * since that is not a property of the match.
 */
export function compareRankedRows<Row extends RankableRow>(
  a: RankedRow<Row>,
  b: RankedRow<Row>,
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.row.ref.length !== b.row.ref.length) {
    return a.row.ref.length - b.row.ref.length;
  }
  return a.row.ref.localeCompare(b.row.ref);
}

/**
 * The rows that match `query`, best first. An empty query matches every row
 * with score 0, in the order given; callers that want a browsable catalog for
 * the empty case order it themselves.
 */
export function rankRows<Row extends RankableRow>(
  query: string,
  rows: readonly Row[],
): RankedRow<Row>[] {
  const ranked: RankedRow<Row>[] = [];
  for (const row of rows) {
    const match = scorePickRow(query, row);
    if (!match) continue;
    ranked.push({ row, score: match.score, positions: match.positions });
  }
  return ranked.sort(compareRankedRows);
}
