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
 * neither drawn to the same vertical metrics as the checkbox. The small one
 * reads as sitting low beside it. The chevron is a text-weight glyph that sits
 * on the same optical line.
 */
export const POINTER = "❯ ";
const NO_POINTER = "  ";

const SEARCH_PROMPT = "Search: ";

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
   * Terminal width, so a line can be kept to one row. Absent means unlimited,
   * which is what the unit tests use.
   */
  columns?: number;
  palette?: PickPalette;
  /** The verb Enter performs, for the legend. Absent means `install`. */
  action?: string;
}

/** The gutter `pick.ts` draws before every body line, and the cells it takes. */
export const GUTTER = "│  ";
export const GUTTER_WIDTH = GUTTER.length;

/** Below this, a hint is dropped rather than shown as a stub. */
const MIN_HINT_WIDTH = 12;

/**
 * Cells one body line may fill on a terminal `columns` wide.
 *
 * Every renderer is handed this number rather than the width, so the two
 * subtractions are written once. The gutter is the caller's decoration, and
 * the extra cell is the auto-wrap rule: a line that fills the last column
 * wraps on terminals that wrap there, and a wrapped line breaks the redraw for
 * the whole frame, because the rewind then counts one line where two were
 * drawn.
 *
 * An absent width is unlimited, which the arithmetic below carries on its own.
 */
export function bodyBudget(columns: number | undefined): number {
  if (columns === undefined) return Number.POSITIVE_INFINITY;
  return columns - 1 - GUTTER_WIDTH;
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
  budget = Number.POSITIVE_INFINITY,
): string[] {
  if (tabs.length === 0) return [];
  const labels = tabs.map((tab) => tab.label);
  const activeLabel = labels[active] as string;

  // Too narrow for every name: name the active one and say where it sits.
  // Wrapping the bar would cost more than the other names are worth.
  if (labels.join(" │ ").length > budget) {
    const position = `(${active + 1}/${tabs.length})`;
    // `‹ ` and ` › ` around the name, and the space before the position.
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

  // The rule is positioned from the *unstyled* widths: escape sequences carry
  // no width, so measuring the styled string puts the rule in the wrong place.
  let offset = 0;
  for (let index = 0; index < active; index++) {
    offset += (labels[index] as string).length + 3; // label + " │ "
  }
  const rule = `${" ".repeat(offset)}${"━".repeat(activeLabel.length)}`;
  return [bar, rule];
}

/**
 * `Search: rev█` on the left, `2 of 7` on the right.
 *
 * A query the user keeps typing is the one string in the frame that grows
 * without limit, so it is the one the line gives up first. The count goes
 * before it, and the query then loses its head rather than its tail: the caret
 * and the characters just typed are what the user is watching.
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

/**
 * The row lines, with per-kind headings when the state calls for them.
 *
 * Returns at most `height` lines, windowed so the cursor is always visible.
 */
export function renderRows(frame: PickFrame): string[] {
  const palette = frame.palette ?? PLAIN_PALETTE;
  const budget = bodyBudget(frame.columns);
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
  // A heading is the label for the rows under it, so one at the bottom edge
  // labels nothing. Dropping it costs a line of the budget and removes a
  // group name that appears to have no members.
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
  // Everything before the ref: the pointer column, the heading indent, the
  // checkbox, and the space after it. The gutter is already out of the budget.
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
  // The hint is drawn only for the focused row. Every row carrying its own
  // description would push the refs apart and turn the list into prose, and
  // building one costs a collapse and a truncation of the whole description.
  const tail = hintTail(
    opts.focused ? pickRowHint(entry.row) : undefined,
    usable - clamped.cells - 2,
    palette,
  );
  const pointer = opts.focused ? palette.accent(POINTER) : NO_POINTER;
  return `${pointer}${opts.indent}${box} ${label}${tail}`;
}

/**
 * `text`, cut to `limit` code points with an ellipsis when it does not fit.
 *
 * Code points, to match what `fuzzy.ts` counts and what `highlightRef` walks.
 * Slicing the string directly could cut a surrogate pair in half.
 *
 * A limit under two cannot hold a character and the ellipsis that says one was
 * dropped, and a negative slice would take from the end, so it yields nothing.
 */
function truncateEnd(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit < 2) return "";
  return `${chars.slice(0, limit - 1).join("")}…`;
}

/** `text`, cut to `limit` code points, keeping the tail rather than the head. */
function truncateStart(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  if (limit < 2) return "";
  return `…${chars.slice(chars.length - limit + 1).join("")}`;
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
 * The dim text after the focused row's ref, cut to what the line has left.
 *
 * Padding every row to the longest ref aligned a single hint against nothing
 * and stranded it far from the item it describes, and left every other row
 * carrying trailing blanks. A hint with almost no room is dropped rather than
 * shown as a stub.
 */
function hintTail(
  hint: string | undefined,
  available: number,
  palette: PickPalette,
): string {
  if (!hint || available < MIN_HINT_WIDTH) return "";
  return `  ${palette.dim(truncateEnd(hint, available))}`;
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
 * terminal gets fewer words rather than a second line. `action` is the verb
 * Enter performs — `install` for the shelf, `share` and `promote` for the
 * publication pickers — because a legend naming the wrong verb teaches the
 * wrong thing.
 */
const SHORTEST_LEGEND = "tab · enter";

export function renderLegend(
  palette: PickPalette = PLAIN_PALETTE,
  budget = Number.POSITIVE_INFINITY,
  action = "install",
): string {
  const legends = [
    `←/→ type · ↑/↓ move · tab mark · enter ${action} · esc skip`,
    "←/→ type · ↑/↓ move · tab mark · enter",
    `tab mark · enter ${action}`,
    SHORTEST_LEGEND,
  ];
  const text =
    legends.find((legend) => legend.length <= budget) ?? SHORTEST_LEGEND;
  return palette.dim(text);
}

/** Assemble every part into the lines the prompt draws. */
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
  lines.push("", renderLegend(palette, budget, frame.action));
  return lines;
}
