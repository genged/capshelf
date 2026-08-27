/**
 * The picker's type menu: the tab bar across the top, and which rows each tab
 * shows.
 *
 * A tab is a scope, not a jump target. Selecting `skills` filters the list to
 * skills, and the rows inside stay ranked best-match-first, so the cursor is
 * always on the top match. Grouping the whole list under headings and moving
 * the cursor between headings was the other option, and it puts the best match
 * somewhere in the middle of the list.
 *
 * Pure: no terminal, no prompt library. `pick-frame.ts` draws these.
 */
import { PICK_KIND_ORDER } from "./pick-core";
import type { PickKind, PickRow } from "./pick-core";

/** `all` is a real tab, always first, and is the one the picker opens on. */
export type PickTabKey = "all" | PickKind;

export interface PickTab {
  key: PickTabKey;
  label: string;
  /** Rows this tab would show, before any query. */
  count: number;
}

/**
 * Build the tab bar for a catalog: `All`, then every kind that has at least
 * one row, in the caller's kind order (the shelf catalog's by default).
 *
 * An empty kind gets no tab. A tab that shows nothing is a dead stop when
 * cycling, and the shelf's shape is exactly what the bar should report.
 */
export function pickTabs(
  rows: readonly PickRow[],
  order: readonly PickKind[] = PICK_KIND_ORDER,
): PickTab[] {
  const tabs: PickTab[] = [{ key: "all", label: "All", count: rows.length }];
  for (const kind of order) {
    const count = rows.filter((row) => row.kind === kind).length;
    if (count > 0) tabs.push({ key: kind, label: kind, count });
  }
  return tabs;
}

/** The rows one tab shows. `all` shows everything. */
export function rowsForTab(
  rows: readonly PickRow[],
  key: PickTabKey,
): PickRow[] {
  return key === "all" ? [...rows] : rows.filter((row) => row.kind === key);
}

/**
 * Move `active` by `delta`, wrapping at both ends.
 *
 * Wrapping rather than stopping: the bar is short, and a user holding one
 * arrow key to survey the shelf should not have to notice which end they are
 * at.
 */
export function stepTab(count: number, active: number, delta: number): number {
  if (count <= 0) return 0;
  return (((active + delta) % count) + count) % count;
}

/**
 * Whether the list should be drawn under per-kind headings.
 *
 * Exactly one state gets them: the `All` tab with no query. Every other state
 * is either a single kind, where a heading repeats the tab, or a ranked
 * result, where headings would split the ranking and bury the best match in
 * the middle of the list.
 */
export function showsGroupHeadings(key: PickTabKey, query: string): boolean {
  return key === "all" && query.trim().length === 0;
}
