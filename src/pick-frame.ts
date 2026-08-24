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

export const MARKED = "◉";
export const UNMARKED = "◯";

/**
 * The focused-row marker, and the blank that reserves its column.
 *
 * Both are two cells wide so the checkbox lands in the same column on every
 * row. A one-cell marker put the marker hard against the box and the two
 * rendered as a single blob.
 *
 * A chevron, not a triangle. `◯` and `◉` are round, and the right-pointing
 * triangles Unicode offers are a small one (`▸`) and a full-size one (`▶`),
 * neither drawn to the same vertical metrics as the checkbox — the small one
 * reads as sitting low beside it. The chevron is a text-weight glyph that sits
 * on the same optical line.
 */
export const POINTER = "❯ ";
const NO_POINTER = "  ";

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
  /**
   * Terminal width, so a row can be kept to one line. Absent means unlimited,
   * which is what the unit tests use.
   */
  columns?: number;
  palette?: PickPalette;
}

/** Cells the caller's gutter takes before every body line. */
export const GUTTER_WIDTH = 3;

/** Below this, a hint is dropped rather than shown as a stub. */
const MIN_HINT_WIDTH = 12;

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
  columns?: number,
): string[] {
  if (tabs.length === 0) return [];
  const labels = tabs.map((tab) => tab.label);

  // Too narrow for every name: name the active one and say where it sits.
  // Wrapping the bar would cost more than the other names are worth, because
  // a wrapped line breaks the redraw for the whole frame.
  const plainWidth = labels.join(" │ ").length + GUTTER_WIDTH;
  if (columns !== undefined && plainWidth > columns - 1) {
    const position = palette.dim(`(${active + 1}/${tabs.length})`);
    return [
      `${palette.dim("‹")} ${palette.accent(labels[active] as string)} ${palette.dim("›")} ${position}`,
    ];
  }

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
        focused: item.entry === frame.rows[frame.cursor],
        marked: frame.marked.has(item.entry.row.ref),
        palette,
        ...(frame.columns !== undefined && { columns: frame.columns }),
      }),
    );
  }
  // A heading is the label for the rows under it, so one at the bottom edge
  // labels nothing. Dropping it costs a line of the budget and removes a
  // group name that appears to have no members.
  if (lines.length > 0 && isHeadingLine(display, window.end - 1)) lines.pop();
  return lines;
}

function isHeadingLine(
  display: ReadonlyArray<{ heading: string } | { entry: RankedPickRow }>,
  index: number,
): boolean {
  const item = display[index];
  return item !== undefined && "heading" in item;
}

function renderRow(
  entry: RankedPickRow,
  opts: {
    indent: string;
    focused: boolean;
    marked: boolean;
    palette: PickPalette;
    columns?: number;
  },
): string {
  const { palette } = opts;
  // Everything before the ref: the caller's gutter, the pointer column, the
  // heading indent, the checkbox, and the space after it.
  const prefixCells = GUTTER_WIDTH + POINTER.length + opts.indent.length + 2;
  const usable =
    opts.columns === undefined
      ? Number.POSITIVE_INFINITY
      : // One cell short of the width: a line that fills the last column
        // wraps on terminals that auto-wrap there.
        opts.columns - 1 - prefixCells;

  const clamped = clampRef(entry.row.ref, entry.positions, usable);
  const box = entry.row.installed
    ? palette.disabled(UNMARKED)
    : opts.marked
      ? palette.accent(MARKED)
      : UNMARKED;
  const label = entry.row.installed
    ? palette.disabled(clamped.text)
    : highlightRef(clamped.text, clamped.positions, palette.accent);
  const tail = hintTail(
    pickRowHint(entry.row),
    prefixCells + clamped.cells,
    opts,
  );
  const pointer = opts.focused ? palette.accent(POINTER) : NO_POINTER;
  return `${pointer}${opts.indent}${box} ${label}${tail}`;
}

/**
 * Shorten a ref that cannot fit, and drop the highlight positions that fall
 * outside what is left.
 *
 * A row wider than the terminal wraps onto a second line, and the redraw then
 * counts one line where two were drawn, so the frame walks up the screen on
 * every keystroke. Losing the tail of a rare long name is the smaller cost.
 */
function clampRef(
  ref: string,
  positions: readonly number[],
  limit: number,
): { text: string; cells: number; positions: number[] } {
  // Code points, to match what `fuzzy.ts` counts and what `highlightRef`
  // walks. Slicing the string directly could cut a surrogate pair in half.
  const chars = [...ref];
  if (chars.length <= limit) {
    return { text: ref, cells: chars.length, positions: [...positions] };
  }
  if (limit < 2) return { text: "", cells: 0, positions: [] };
  return {
    text: `${chars.slice(0, limit - 1).join("")}…`,
    cells: limit,
    positions: positions.filter((position) => position < limit - 1),
  };
}

/**
 * The dim text after the focused row's ref, cut to what the line has left.
 *
 * Only the focused row gets one. Padding every row to the longest ref aligned
 * a single hint against nothing and stranded it far from the item it
 * describes, and left every other row carrying trailing blanks.
 */
function hintTail(
  hint: string | undefined,
  usedCells: number,
  opts: { focused: boolean; columns?: number; palette: PickPalette },
): string {
  if (!opts.focused || !hint) return "";
  if (opts.columns === undefined) return `  ${opts.palette.dim(hint)}`;
  const available = opts.columns - 1 - usedCells - 2;
  if (available < MIN_HINT_WIDTH) return "";
  const chars = [...hint];
  const shown =
    chars.length <= available
      ? hint
      : `${chars.slice(0, available - 1).join("")}…`;
  return `  ${opts.palette.dim(shown)}`;
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

/**
 * The key legend under the list, in the longest form that fits.
 *
 * A legend that wraps breaks the redraw for the whole frame, so a narrow
 * terminal gets fewer words rather than a second line.
 */
const LEGENDS = [
  "←/→ type · ↑/↓ move · tab mark · enter install · esc skip",
  "←/→ type · ↑/↓ move · tab mark · enter",
  "tab mark · enter install",
  "tab · enter",
] as const;

export function renderLegend(
  palette: PickPalette = PLAIN_PALETTE,
  columns?: number,
): string {
  const budget =
    columns === undefined
      ? Number.POSITIVE_INFINITY
      : columns - 1 - GUTTER_WIDTH;
  const text =
    LEGENDS.find((legend) => legend.length <= budget) ?? LEGENDS.at(-1) ?? "";
  return palette.dim(text);
}

/** Assemble every part into the lines the prompt draws. */
export function renderPickBody(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const total = frame.tabs[frame.activeTab]?.count ?? 0;
  const lines = [
    ...renderTabBar(frame.tabs, frame.activeTab, palette, frame.columns),
    renderSearchLine(frame.query, frame.rows.length, total, palette),
    "",
  ];
  if (frame.rows.length === 0) {
    lines.push(palette.dim("no matches"));
  } else {
    lines.push(...renderRows(frame));
  }
  lines.push("", renderLegend(palette, frame.columns));
  return lines;
}
