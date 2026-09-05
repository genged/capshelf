/**
 * Pure helpers the dashboard uses to order, count, and filter the rows the
 * server sends. They carry no DOM, so they are unit tests.
 */
import type { UiItem } from "./api-types";

export type FilterTab = "all" | "attention" | "ok";

export interface ProjectCounts {
  items: number;
  attention: number;
  ok: number;
  kept: number;
}

export function projectCounts(items: readonly UiItem[]): ProjectCounts {
  let attention = 0;
  let kept = 0;
  for (const item of items) {
    if (item.attention) attention += 1;
    else if (item.tone === "kept") kept += 1;
  }
  return {
    items: items.length,
    attention,
    ok: items.length - attention - kept,
    kept,
  };
}

const TONE_ORDER = { attention: 0, kept: 1, ok: 2 } as const;

/** Attention first, then kept-local, then up to date; each group by ref. */
export function sortItems(items: readonly UiItem[]): UiItem[] {
  return [...items].sort((a, b) => {
    const toneA = a.attention ? 0 : TONE_ORDER[a.tone];
    const toneB = b.attention ? 0 : TONE_ORDER[b.tone];
    if (toneA !== toneB) return toneA - toneB;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
  });
}

export function matchesQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return text.toLowerCase().includes(needle);
}

export function filterItems(
  items: readonly UiItem[],
  tab: FilterTab,
  query: string,
): UiItem[] {
  return sortItems(items).filter((item) => {
    if (tab === "attention" && !item.attention) return false;
    if (tab === "ok" && item.attention) return false;
    return matchesQuery(item.ref, query);
  });
}

/** `5 items · 3 up to date · 1 update available · 1 drifted`. */
export function summaryLine(items: readonly UiItem[]): string {
  const parts: string[] = [
    `${items.length} ${items.length === 1 ? "item" : "items"}`,
  ];
  const counts = new Map<string, number>();
  for (const item of sortItems(items)) {
    const label = item.stateLabel.toLowerCase();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ok = counts.get("up to date");
  if (ok !== undefined) parts.push(`${ok} up to date`);
  for (const [label, count] of counts) {
    if (label === "up to date") continue;
    parts.push(`${count} ${label}`);
  }
  return parts.join(" · ");
}

/**
 * The rows whose state or identity moved between two refreshes. The UI
 * highlights each once.
 */
export function changedItemIds(
  previous: readonly UiItem[] | undefined,
  next: readonly UiItem[],
): Set<string> {
  const out = new Set<string>();
  if (!previous) return out;
  const before = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) {
    const old = before.get(item.id);
    if (!old) {
      out.add(item.id);
      continue;
    }
    if (
      old.row.state !== item.row.state ||
      old.row.lockedSha !== item.row.lockedSha ||
      old.row.currentSha !== item.row.currentSha ||
      old.row.upstreamSha !== item.row.upstreamSha ||
      old.row.needsState !== item.row.needsState
    ) {
      out.add(item.id);
    }
  }
  return out;
}

export type TreeState = "loading" | "ready" | "error" | "missing";

export interface TreeEntry {
  path: string;
  display: string;
  state: TreeState;
  counts: ProjectCounts | null;
}

/** Attention count descending, then the display path. */
export function sortTree(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const attentionA = a.counts?.attention ?? -1;
    const attentionB = b.counts?.attention ?? -1;
    if (attentionA !== attentionB) return attentionB - attentionA;
    return a.display < b.display ? -1 : a.display > b.display ? 1 : 0;
  });
}

/** The first twelve characters of a 64-character digest, as the CLI prints. */
export function shortDigest(value: string | null | undefined): string {
  if (!value) return "(missing)";
  return value.length === 64 ? value.slice(0, 12) : value;
}

export function shortCommit(value: string | null | undefined): string {
  if (!value) return "";
  return value.length >= 40 ? value.slice(0, 7) : value;
}

/**
 * The CLI prints some sentences with a full 64-character digest. The panel
 * shows the same sentence with the 12-character form the CLI uses elsewhere.
 */
export function shortenDigests(text: string): string {
  return text.replace(/\b[0-9a-f]{64}\b/g, (digest) => digest.slice(0, 12));
}
