/**
 * Tabs filter rather than group under headings so the cursor stays on the best
 * match.
 */
import { PICK_KIND_ORDER } from "./pick-core";
import type { PickKind, PickRow } from "./pick-core";

export type PickTabKey = "all" | PickKind;

export interface PickTab {
  key: PickTabKey;
  label: string;
  count: number;
}

/**
 * Empty kinds get no tab, since a tab showing nothing is a dead stop when
 * cycling.
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

export function rowsForTab(
  rows: readonly PickRow[],
  key: PickTabKey,
): PickRow[] {
  return key === "all" ? [...rows] : rows.filter((row) => row.kind === key);
}

/**
 * Wraps at both ends so a user holding an arrow key needn't notice which end
 * they are at.
 */
export function stepTab(count: number, active: number, delta: number): number {
  if (count <= 0) return 0;
  return (((active + delta) % count) + count) % count;
}

/**
 * Headings only on the unfiltered `All` tab: elsewhere they repeat the tab or
 * split a ranking and bury the best match.
 */
export function showsGroupHeadings(key: PickTabKey, query: string): boolean {
  return key === "all" && query.trim().length === 0;
}
