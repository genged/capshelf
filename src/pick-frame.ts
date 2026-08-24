/**
 * The picker's frame, assembled as plain strings.
 *
 * Every line the picker draws is built here, by pure functions, so the layout
 * is a unit test rather than something you must drive a pseudo-terminal to
 * look at. `pick.ts` hands the result to the prompt library and does nothing
 * else with it.
 *
 * Styling is injected as a `PickPalette` rather than imported, for the same
 * reason `highlightRef` takes a `paint` function: a module that owns escape
 * sequences cannot be asserted on as text.
 */
import { highlightRef, pickRowHint } from "./pick-core";
import type { RankedPickRow } from "./pick-core";
import { showsGroupHeadings } from "./pick-tabs";
import type { PickTab } from "./pick-tabs";

export interface PickPalette {
  /** The active tab, and matched characters inside a ref. */
  accent(text: string): string;
  /** Hints, counts, and the key legend. */
  dim(text: string): string;
  /** An already-installed row, which cannot be marked. */
  disabled(text: string): string;
}

/** Identity styling. Tests use it to assert on text. */
export const PLAIN_PALETTE: PickPalette = {
  accent: (text) => text,
  dim: (text) => text,
  disabled: (text) => text,
};

export const MARKED = "◼";
export const UNMARKED = "◻";

export interface PickFrame {
  tabs: PickTab[];
  activeTab: number;
  query: string;
  /** Ranked rows for the active tab, in display order. */
  rows: RankedPickRow[];
  /** Index into `rows`, or -1 when there is nothing to point at. */
  cursor: number;
  marked: ReadonlySet<string>;
  /** Maximum row lines to draw, headings included. */
  height: number;
  palette?: PickPalette;
}

/**
 * The tab bar: `All │ bundles │ skills`, with the active one accented and
 * underlined.
 *
 * Two lines, not one. Colour alone would carry the selection, and it is the
 * one part of the frame a user reads at a glance while holding an arrow key,
 * so it also gets a rule underneath that survives a monochrome terminal.
 */
export function renderTabBar(
  tabs: readonly PickTab[],
  active: number,
  palette: PickPalette = PLAIN_PALETTE,
): string[] {
  if (tabs.length === 0) return [];
  const labels = tabs.map((tab) => tab.label);
  const bar = labels
    .map((label, index) =>
      index === active ? palette.accent(label) : palette.dim(label),
    )
    .join(" │ ");

  // The rule is positioned from the *unstyled* widths: escape sequences carry
  // no width, so measuring the styled string puts the rule in the wrong place.
  let offset = 0;
  for (let index = 0; index < active; index++) {
    offset += (labels[index] as string).length + 3; // label + " │ "
  }
  const rule = `${" ".repeat(offset)}${"━".repeat((labels[active] as string).length)}`;
  return [bar, rule];
}

/** `Search: rev█` on the left, `2 of 7` on the right. */
export function renderSearchLine(
  query: string,
  shown: number,
  total: number,
  palette: PickPalette = PLAIN_PALETTE,
): string {
  const count = palette.dim(`${shown} of ${total}`);
  return `Search: ${query}█   ${count}`;
}

/**
 * The row lines, with per-kind headings when the state calls for them.
 *
 * Returns at most `height` lines, windowed so the cursor is always visible.
 */
export function renderRows(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const width = Math.max(0, ...frame.rows.map((entry) => entry.row.ref.length));
  const grouped = showsGroupHeadings(
    frame.tabs[frame.activeTab]?.key ?? "all",
    frame.query,
  );

  // Lay the headings out first, then window the result.
  //
  // Windowing the rows and inserting headings afterwards spends more lines
  // than `height` allows: the grouped `All` view could add one heading per
  // kind, turning a budget of 10 into as many as 17 lines and pushing the
  // frame past a 24-row terminal. `height` has to bound what is drawn, so it
  // is applied to the drawn sequence.
  const display: Array<{ heading: string } | { entry: RankedPickRow }> = [];
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
      lines.push(palette.dim(item.heading));
      continue;
    }
    lines.push(
      renderRow(item.entry, {
        indent: grouped ? "  " : "",
        width,
        focused: item.entry === frame.rows[frame.cursor],
        marked: frame.marked.has(item.entry.row.ref),
        palette,
      }),
    );
  }
  return lines;
}

function renderRow(
  entry: RankedPickRow,
  opts: {
    indent: string;
    width: number;
    focused: boolean;
    marked: boolean;
    palette: PickPalette;
  },
): string {
  const { palette } = opts;
  const ref = highlightRef(entry.row.ref, entry.positions, palette.accent);
  const padding = " ".repeat(Math.max(0, opts.width - entry.row.ref.length));
  const box = entry.row.installed
    ? palette.disabled(UNMARKED)
    : opts.marked
      ? palette.accent(MARKED)
      : UNMARKED;
  const label = entry.row.installed ? palette.disabled(entry.row.ref) : ref;
  const hint = pickRowHint(entry.row);
  // The hint is drawn only for the focused row. Every row carrying its own
  // description would push the refs apart and turn the list into prose.
  const tail = opts.focused && hint ? `  ${palette.dim(hint)}` : "";
  const pointer = opts.focused ? "❯" : " ";
  return `${pointer}${opts.indent}${box} ${label}${padding}${tail}`;
}

/**
 * The slice of a list to draw so that `cursor` is inside it.
 *
 * Scrolls by whole steps at the edges rather than re-centring on every move,
 * so a list that fits does not shift under the cursor.
 */
export function visibleWindow(
  total: number,
  cursor: number,
  height: number,
): { start: number; end: number } {
  if (height <= 0 || total <= 0) return { start: 0, end: 0 };
  if (total <= height) return { start: 0, end: total };
  const half = Math.floor(height / 2);
  const start = Math.min(
    Math.max(0, cursor - half),
    Math.max(0, total - height),
  );
  return { start, end: start + height };
}

/** The key legend under the list. */
export function renderLegend(palette: PickPalette = PLAIN_PALETTE): string {
  return palette.dim(
    "←/→ type · ↑/↓ move · tab mark · enter install · esc skip",
  );
}

/** Assemble every part into the lines the prompt draws. */
export function renderPickBody(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const total = frame.tabs[frame.activeTab]?.count ?? 0;
  const lines = [
    ...renderTabBar(frame.tabs, frame.activeTab, palette),
    renderSearchLine(frame.query, frame.rows.length, total, palette),
    "",
  ];
  if (frame.rows.length === 0) {
    lines.push(palette.dim("no matches"));
  } else {
    lines.push(...renderRows(frame));
  }
  lines.push("", renderLegend(palette));
  return lines;
}
