/**
 * Picker uses fuzzy.ts rather than search-core.ts because search is scriptable
 * and needs exact, documented matching, while a live filter can afford loose
 * matches.
 */
import { isTerminalControlCode } from "./assert";
import { fuzzyTerms } from "./fuzzy";
import { compareRankedRows, scorePickRow } from "./pick-rank";
import { ITEM_KINDS } from "./master";
import type { ItemKind } from "./master";
import { truncatedDescription } from "./metadata";

export type PickKind = ItemKind | "bundles";

/**
 * Bundles lead as the curated entry point, so users meet them before the raw
 * item list.
 */
export const PICK_KIND_ORDER: readonly PickKind[] = ["bundles", ...ITEM_KINDS];

export interface PickRow {
  ref: string;
  /**
   * Distinguishes rows sharing a `ref` (e.g. one mcp server per output file);
   * absent means ref is the identity.
   */
  id?: string;
  kind: PickKind;
  name: string;
  description?: string;
  tags: string[];
  /**
   * Stays visible but unmarkable because `add` on an installed item is a no-op
   * that prints guidance, which is noise in a bulk install.
   */
  installed: boolean;
  disabled?: boolean;
  detail?: string;
}

export function isPickKind(value: string): value is PickKind {
  return PICK_KIND_ORDER.some((kind) => kind === value);
}

export function parsePickKind(value: string): PickKind {
  if (isPickKind(value)) return value;
  throw new Error(`invalid pick kind "${value}"`);
}

export function pickRowId(row: PickRow): string {
  return row.id ?? row.ref;
}

export function isPickRowDisabled(row: PickRow): boolean {
  return row.installed || row.disabled === true;
}

export interface RankedPickRow {
  row: PickRow;
  score: number;
  positions: number[];
}

export interface PickFinder {
  find(query: string): RankedPickRow[];
}

export { PICK_FIELD_WEIGHTS, scorePickRow } from "./pick-rank";
export type { PickFieldName } from "./pick-rank";
export const comparePickRows: (a: RankedPickRow, b: RankedPickRow) => number =
  compareRankedRows;

export function orderPickRows(
  rows: readonly PickRow[],
  order: readonly PickKind[] = PICK_KIND_ORDER,
): PickRow[] {
  return [...rows].sort((a, b) => {
    const kinds = order.indexOf(a.kind) - order.indexOf(b.kind);
    if (kinds !== 0) return kinds;
    return a.name.localeCompare(b.name);
  });
}

/**
 * An empty query returns catalog order, not ranked, because tiebreaking
 * all-zero scores would sort by ref length and lose kind grouping.
 */
export function createPickFinder(
  rows: readonly PickRow[],
  order: readonly PickKind[] = PICK_KIND_ORDER,
): PickFinder {
  const ordered = orderPickRows(rows, order);
  return {
    find(query: string): RankedPickRow[] {
      if (fuzzyTerms(query).length === 0) {
        return ordered.map((row) => ({ row, score: 0, positions: [] }));
      }
      const ranked: RankedPickRow[] = [];
      for (const row of ordered) {
        const match = scorePickRow(query, row);
        if (!match) continue;
        ranked.push({ row, score: match.score, positions: match.positions });
      }
      return ranked.sort(comparePickRows);
    },
  };
}

export function highlightRef(
  ref: string,
  positions: readonly number[],
  paint: (matched: string) => string,
): string {
  if (positions.length === 0) return ref;
  const marked = new Set(positions);
  // Walk code points to match fuzzy.ts; indexing UTF-16 units could split a
  // surrogate pair.
  const chars = [...ref];
  let out = "";
  let run = "";
  for (const [index, char] of chars.entries()) {
    if (marked.has(index)) {
      run += char;
      continue;
    }
    if (run) {
      out += paint(run);
      run = "";
    }
    out += char;
  }
  return run ? out + paint(run) : out;
}

/**
 * Descriptions come from untrusted data-repo files and are painted into a live
 * terminal, so every control character, ESC and OSC included, becomes a space.
 * Names are already validated.
 */
export function sanitizeDisplayText(text: string): string {
  let out = "";
  for (const char of text) {
    const control = isTerminalControlCode(char.codePointAt(0) ?? 0);
    out += control ? " " : char;
  }
  return out;
}

export function pickRowHint(row: PickRow): string | undefined {
  const parts: string[] = [];
  if (row.installed) parts.push("already installed");
  if (row.detail) parts.push(sanitizeDisplayText(row.detail));
  if (row.description) {
    parts.push(sanitizeDisplayText(truncatedDescription(row.description)));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
