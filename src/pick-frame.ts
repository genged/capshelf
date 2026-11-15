import {
  highlightRef,
  isPickRowDisabled,
  pickRowHint,
  pickRowId,
} from "./pick-core";
import type { RankedPickRow } from "./pick-core";
import { showsGroupHeadings } from "./pick-tabs";
import type { PickTab } from "./pick-tabs";

export interface PickPalette {
  accent(text: string): string;
  dim(text: string): string;
  disabled(text: string): string;
}

export const PLAIN_PALETTE: PickPalette = {
  accent: (text) => text,
  dim: (text) => text,
  disabled: (text) => text,
};

export const MARKED = "◉";
export const UNMARKED = "◯";

/**
 * Two cells wide so the checkbox column aligns; a chevron because `▸`/`▶` sit
 * off the checkbox's vertical metrics.
 */
export const POINTER = "❯ ";
const NO_POINTER = "  ";

const SEARCH_PROMPT = "Search: ";

export interface PickFrame {
  tabs: PickTab[];
  activeTab: number;
  query: string;
  rows: RankedPickRow[];
  cursor: number;
  marked: ReadonlySet<string>;
  height: number;
  columns?: number;
  palette?: PickPalette;
  action?: string;
  preview?: boolean;
}

export const GUTTER = "│  ";
export const GUTTER_WIDTH = GUTTER.length;

const MIN_HINT_WIDTH = 12;

/**
 * Reserve one extra cell: a line filling the last column wraps on some
 * terminals, which breaks the redraw's line-count rewind.
 */
export function bodyBudget(columns: number | undefined): number {
  if (columns === undefined) return Number.POSITIVE_INFINITY;
  return columns - 1 - GUTTER_WIDTH;
}

/**
 * A rule under the bar keeps the active tab visible on monochrome terminals,
 * where colour alone would carry it.
 */
export function renderTabBar(
  tabs: readonly PickTab[],
  active: number,
  palette: PickPalette = PLAIN_PALETTE,
  budget = Number.POSITIVE_INFINITY,
): string[] {
  if (tabs.length === 0) return [];
  const labels = tabs.map((tab) => tab.label);
  // SAFETY: `active` is a tab index `stepTab` keeps inside [0, tabs.length),
  // and tabs is non-empty here.
  const activeLabel = labels[active] as string;

  // When too narrow, show only the active tab and its position, since wrapping
  // the bar costs more.
  if (labels.join(" │ ").length > budget) {
    const position = `(${active + 1}/${tabs.length})`;
    const name = truncateEnd(activeLabel, budget - 5 - position.length);
    return [
      `${palette.dim("‹")} ${palette.accent(name)} ${palette.dim("›")} ${palette.dim(position)}`,
    ];
  }

  const bar = labels
    .map((label, index) =>
      index === active ? palette.accent(label) : palette.dim(label),
    )
    .join(" │ ");

  // Measure unstyled widths: escape sequences have no width, so styled lengths
  // misplace the rule.
  let offset = 0;
  for (let index = 0; index < active; index++) {
    // SAFETY: index < active < labels.length.
    offset += (labels[index] as string).length + 3;
  }
  const rule = `${" ".repeat(offset)}${"━".repeat(activeLabel.length)}`;
  return [bar, rule];
}

/**
 * The count is dropped first. If the line is still too long, the query loses
 * its head (`truncateStart`), so the caret and the latest keystrokes stay
 * visible.
 */
export function renderSearchLine(
  query: string,
  shown: number,
  total: number,
  palette: PickPalette = PLAIN_PALETTE,
  budget = Number.POSITIVE_INFINITY,
): string {
  const count = `${shown} of ${total}`;
  const full = SEARCH_PROMPT.length + [...query].length + 1 + 3 + count.length;
  if (full <= budget) {
    return `${SEARCH_PROMPT}${query}█   ${palette.dim(count)}`;
  }
  const room = budget - SEARCH_PROMPT.length - 1;
  return `${SEARCH_PROMPT}${truncateStart(query, room)}█`;
}

export function renderRows(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const budget = bodyBudget(frame.columns);
  const grouped = showsGroupHeadings(
    frame.tabs[frame.activeTab]?.key ?? "all",
    frame.query,
  );

  // Lay out headings before windowing so `height` bounds the drawn lines;
  // windowing rows first overflows the terminal.
  const display: DisplayItem[] = [];
  let cursorLine = -1;
  let previousKind: string | null = null;
  for (const [index, entry] of frame.rows.entries()) {
    if (grouped && entry.row.kind !== previousKind) {
      display.push({ heading: entry.row.kind });
      previousKind = entry.row.kind;
    }
    if (index === frame.cursor) cursorLine = display.length;
    display.push({ entry });
  }

  const window = visibleWindow(display.length, cursorLine, frame.height);
  const lines: string[] = [];
  for (let index = window.start; index < window.end; index++) {
    const item = display[index];
    if (item === undefined) continue;
    if ("heading" in item) {
      lines.push(palette.dim(truncateEnd(item.heading, budget)));
      continue;
    }
    lines.push(
      renderRow(item.entry, {
        indent: grouped ? "  " : "",
        focused: item.entry === frame.rows[frame.cursor],
        marked: frame.marked.has(pickRowId(item.entry.row)),
        palette,
        budget,
      }),
    );
  }
  // Drop a trailing heading at the bottom edge since it would label no visible
  // rows.
  const last = display[window.end - 1];
  if (lines.length > 0 && last && "heading" in last) lines.pop();
  return lines;
}

type DisplayItem = { heading: string } | { entry: RankedPickRow };

function renderRow(
  entry: RankedPickRow,
  opts: {
    indent: string;
    focused: boolean;
    marked: boolean;
    palette: PickPalette;
    budget: number;
  },
): string {
  const { palette } = opts;
  const prefixCells = POINTER.length + opts.indent.length + 2;
  const usable = opts.budget - prefixCells;

  const clamped = clampRef(entry.row.ref, entry.positions, usable);
  const disabled = isPickRowDisabled(entry.row);
  const box = disabled
    ? palette.disabled(UNMARKED)
    : opts.marked
      ? palette.accent(MARKED)
      : UNMARKED;
  const label = disabled
    ? palette.disabled(clamped.text)
    : highlightRef(clamped.text, clamped.positions, palette.accent);
  // Hint only on the focused row; per-row descriptions would spread refs apart
  // and cost a truncation per row.
  const tail = hintTail(
    opts.focused ? pickRowHint(entry.row) : undefined,
    usable - clamped.cells - 2,
    palette,
  );
  const pointer = opts.focused ? palette.accent(POINTER) : NO_POINTER;
  return `${pointer}${opts.indent}${box} ${label}${tail}`;
}

/**
 * Counts code points to match fuzzy.ts and avoid splitting surrogate pairs; a
 * limit under 2 yields empty since a negative slice would take from the end.
 */
function truncateEnd(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit < 2) return "";
  return `${chars.slice(0, limit - 1).join("")}…`;
}

function truncateStart(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit < 2) return "";
  return `…${chars.slice(chars.length - limit + 1).join("")}`;
}

/**
 * Clamp refs because a wrapped line makes the redraw rewind miscount and the
 * frame climb the screen each keystroke.
 */
interface ClampedRef {
  text: string;
  cells: number;
  positions: number[];
}

function clampRef(
  ref: string,
  positions: readonly number[],
  limit: number,
): ClampedRef {
  const text = truncateEnd(ref, limit);
  return {
    text,
    cells: [...text].length,
    positions:
      text === ref
        ? [...positions]
        : positions.filter((position) => position < limit - 1),
  };
}

/**
 * Hint is not padded to the longest ref, which would strand it from its item; a
 * hint with little room is dropped.
 */
function hintTail(
  hint: string | undefined,
  available: number,
  palette: PickPalette,
): string {
  if (!hint || available < MIN_HINT_WIDTH) return "";
  return `  ${palette.dim(truncateEnd(hint, available))}`;
}

export interface VisibleWindow {
  start: number;
  end: number;
}

export function visibleWindow(
  total: number,
  cursor: number,
  height: number,
): VisibleWindow {
  if (height <= 0 || total <= 0) return { start: 0, end: 0 };
  if (total <= height) return { start: 0, end: total };
  const half = Math.floor(height / 2);
  const start = Math.min(
    Math.max(0, cursor - half),
    Math.max(0, total - height),
  );
  return { start, end: start + height };
}

/**
 * A wrapped legend breaks the redraw, so narrow terminals get fewer words
 * rather than a second line.
 */
const SHORTEST_LEGEND = "tab · enter";

export function renderLegend(
  palette: PickPalette = PLAIN_PALETTE,
  budget = Number.POSITIVE_INFINITY,
  action = "install",
  preview = false,
): string {
  const legends = [
    `←/→ type · ↑/↓ move · tab mark${preview ? " · ctrl+v diff" : ""} · enter ${action} · esc skip`,
    "←/→ type · ↑/↓ move · tab mark · enter",
    `tab mark${preview ? " · ctrl+v diff" : ""} · enter ${action}`,
    SHORTEST_LEGEND,
  ];
  const text =
    legends.find((legend) => legend.length <= budget) ?? SHORTEST_LEGEND;
  return palette.dim(text);
}

export function renderPickBody(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const budget = bodyBudget(frame.columns);
  const total = frame.tabs[frame.activeTab]?.count ?? 0;
  const lines = [
    ...renderTabBar(frame.tabs, frame.activeTab, palette, budget),
    renderSearchLine(frame.query, frame.rows.length, total, palette, budget),
    "",
  ];
  if (frame.rows.length === 0) {
    lines.push(palette.dim("no matches"));
  } else {
    lines.push(...renderRows(frame));
  }
  lines.push(
    "",
    renderLegend(palette, budget, frame.action, frame.preview === true),
  );
  return lines;
}
