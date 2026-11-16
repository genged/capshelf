/**
 * Kept apart from pick-core.ts so the web UI can bundle it; imports only
 * fuzzy.ts.
 */
import { fuzzyMatchV1, fuzzyTerms } from "./fuzzy";

/**
 * Fields are scored separately and weighted because fzf's whitespace bonus over
 * delimiters ranked description words above names when concatenated.
 */
export const PICK_FIELD_WEIGHTS = {
  ref: 8,
  tags: 4,
  description: 2,
} as const;

export type PickFieldName = keyof typeof PICK_FIELD_WEIGHTS;

export interface RankableRow {
  ref: string;
  tags: string[];
  description?: string;
}

export interface RankedRow<Row extends RankableRow> {
  row: Row;
  score: number;
  positions: number[];
}

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
    // Only ref positions are highlighted because only the ref is rendered in
    // full.
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
 * Length tiebreak follows fzf's default and resolves exact score ties; measure
 * ref, not haystack, so descriptions don't decide it.
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
