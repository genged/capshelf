/**
 * The pure half of the interactive picker: the row model, the ordering, and
 * the label text. No terminal, no filesystem, no prompt library — so the
 * ranking and every rendered string are unit tests rather than something you
 * must drive a pseudo-terminal to see.
 *
 * Matching is `fuzzy.ts` (fzf's FuzzyMatchV1), not `search-core.ts`. The two
 * stay apart on purpose. `capshelf search` is a scriptable command whose
 * result set a user cites and reruns, so it keeps exact substrings and its
 * documented weights. The picker is a live filter corrected by typing one more
 * character, so a loose match costs nothing and `secrev` should find
 * `skills/security-review`.
 *
 * `pick.ts` is the shell that puts these rows on a terminal.
 */
import { isTerminalControlCode } from "./assert";
import { fuzzyTerms } from "./fuzzy";
import { compareRankedRows, scorePickRow } from "./pick-rank";
import { ITEM_KINDS } from "./master";
import type { ItemKind } from "./master";
import { truncatedDescription } from "./metadata";

/** A picker row is an installable item or a bundle of them. */
export type PickKind = ItemKind | "bundles";

/**
 * Bundles first, then the canonical kind order. Bundles lead because they are
 * the curated entry point `init` has always recommended, and a user who does
 * not know the shelf should meet the curated sets before the raw item list.
 */
export const PICK_KIND_ORDER: readonly PickKind[] = ["bundles", ...ITEM_KINDS];

export interface PickRow {
  /** Kind-qualified ref, e.g. `skills/security-review` or `bundles/review-kit`. */
  ref: string;
  /**
   * Identity apart from the label, for catalogs where two rows share a `ref` —
   * a share catalog offers one mcp server once per output file, and both rows
   * are labelled with the server name. Absent means the `ref` is the identity,
   * so `add` does not change. Marks, the cursor, and the picked result all use
   * `pickRowId`.
   */
  id?: string;
  kind: PickKind;
  name: string;
  description?: string;
  tags: string[];
  /**
   * Already installed in the project. The row stays visible so the shelf reads
   * as the shelf, but it cannot be marked: `add` on an installed item is a
   * no-op that prints guidance, which is noise inside a bulk install.
   */
  installed: boolean;
  /**
   * Visible but unmarkable for a reason that is not "already installed" — a
   * promote row whose state has nothing to promote. The `detail` carries the
   * reason; the row draws struck through like an installed one.
   */
  disabled?: boolean;
  /** Right-hand annotation, e.g. a bundle's `4 skills · 2 mcp` summary. */
  detail?: string;
}

export function isPickKind(value: string): value is PickKind {
  return PICK_KIND_ORDER.some((kind) => kind === value);
}

/** The kind a fixture or a row id names, or a refusal. */
export function parsePickKind(value: string): PickKind {
  if (isPickKind(value)) return value;
  throw new Error(`invalid pick kind "${value}"`);
}

/** The string marks and the picked result carry for a row. */
export function pickRowId(row: PickRow): string {
  return row.id ?? row.ref;
}

/** Whether the row is visible but cannot be marked. */
export function isPickRowDisabled(row: PickRow): boolean {
  return row.installed || row.disabled === true;
}

export interface RankedPickRow {
  row: PickRow;
  score: number;
  /** Highlight positions inside `row.ref`, ascending. */
  positions: number[];
}

export interface PickFinder {
  find(query: string): RankedPickRow[];
}

/**
 * The ranking lives in `pick-rank.ts`, which is browser-safe; these names
 * stay exported here so the picker's callers and tests read one module.
 */
export { PICK_FIELD_WEIGHTS, scorePickRow } from "./pick-rank";
export type { PickFieldName } from "./pick-rank";
export const comparePickRows: (a: RankedPickRow, b: RankedPickRow) => number =
  compareRankedRows;

/**
 * Order the catalog for an empty query: bundles first, then kind order, then
 * name. This ordering *is* the browsable catalog a user sees before typing.
 *
 * The order is a parameter with the shelf catalog's value as its default, so a
 * caller with its own catalog — the share picker's three fragment kinds —
 * states its order instead of inheriting one built for `add`.
 */
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
 * Build the finder once per picker session; `find` runs per keystroke.
 *
 * An empty query returns the catalog in `orderPickRows` order rather than a
 * ranked list. Every row would score 0, and letting the tiebreaker sort those
 * would replace the kind grouping with a list ordered by ref length, which
 * reads as random to someone who has not typed anything yet.
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

/**
 * Wrap the matched characters of `ref` with `paint`.
 *
 * `paint` is injected rather than imported so this module never owns an escape
 * sequence: tests pass a marker function and assert on text.
 */
export function highlightRef(
  ref: string,
  positions: readonly number[],
  paint: (matched: string) => string,
): string {
  if (positions.length === 0) return ref;
  const marked = new Set(positions);
  // Walk code points, because that is what `fuzzy.ts` counts. Indexing the
  // string directly would step through UTF-16 halves and let a paint land
  // inside a surrogate pair.
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
 * Remove terminal control sequences from text that came out of a data repo.
 *
 * A description is read from an item's `.capshelf.yml` or its SKILL.md
 * frontmatter, so its bytes are chosen by whoever writes the shelf, not by the
 * user running the command. YAML can carry an escape, and the picker paints
 * this text into a live frame — `capshelf init` draws the focused row's hint
 * before the user has selected anything. Raw ESC or OSC bytes there could
 * redraw the frame's own text or drive the terminal.
 *
 * Item and bundle names are already constrained by `assertSafeItemName` and
 * `isValidBundleName`, so the ref needs no filtering; the description does.
 */
export function sanitizeDisplayText(text: string): string {
  let out = "";
  for (const char of text) {
    // C0 (which is where ESC lives), DEL, and C1.
    const control = isTerminalControlCode(char.codePointAt(0) ?? 0);
    out += control ? " " : char;
  }
  return out;
}

/**
 * The dim text after a row's ref: what the item is, and why it cannot be
 * picked when it cannot.
 */
export function pickRowHint(row: PickRow): string | undefined {
  const parts: string[] = [];
  if (row.installed) parts.push("already installed");
  if (row.detail) parts.push(sanitizeDisplayText(row.detail));
  if (row.description) {
    parts.push(sanitizeDisplayText(truncatedDescription(row.description)));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
