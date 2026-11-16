/**
 * Uses `@clack/core` directly for its `render` hook; draws on stderr so stdout
 * stays clean for `--json` results.
 */
import { AutocompletePrompt, isCancel } from "@clack/core";
import type { Key } from "node:readline";
import {
  createPickFinder,
  isPickRowDisabled,
  pickRowId,
  sanitizeDisplayText,
} from "./pick-core";
import type { PickFinder, PickKind, PickRow, RankedPickRow } from "./pick-core";
import { GUTTER, bodyBudget, renderPickBody } from "./pick-frame";
import type { PickPalette } from "./pick-frame";
import { pickTabs, rowsForTab, stepTab } from "./pick-tabs";
import type { PickTab } from "./pick-tabs";
import { highlightTerminalDiff, truncateAnsiLine } from "./terminal-diff";

export interface PickPreview {
  text: string;
  version?: string;
}

export interface PickRequest {
  rows: PickRow[];
  message: string;
  kindOrder?: readonly PickKind[];
  action?: string;
  preview?: (row: PickRow) => Promise<PickPreview>;
}

export type PickUnavailableReason =
  | "no-terminal"
  | "dumb-terminal"
  | "empty-shelf";

export type PickOutcome =
  | {
      kind: "picked";
      refs: string[];
      previewVersions?: Record<string, string>;
    }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: PickUnavailableReason };

export function pickUnavailableMessage(reason: PickUnavailableReason): string {
  switch (reason) {
    case "no-terminal":
      return "no interactive terminal";
    case "dumb-terminal":
      return "TERM=dumb cannot draw a full-screen prompt";
    case "empty-shelf":
      return "the data repo has no items or bundles yet";
  }
}

/**
 * A dumb, empty, or unset TERM is refused. On `dumb`, readline ignores the key
 * argument to `write`, so the query clear never happens and `Tab` arrives as a
 * literal tab.
 */
function isDumbTerminal(term = process.env.TERM): boolean {
  return term === undefined || term === "" || term === "dumb";
}

export interface PickContext {
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  /**
   * Defaults to capable so an injected context never depends on the ambient
   * `TERM`.
   */
  capableTerminal?: boolean;
  prompt(request: PickRequest): Promise<PickOutcome>;
}

const ACCENT = "\x1b[36m";
const DIM = "\x1b[2m";
const DISABLED = "\x1b[9m\x1b[90m";
const RESET = "\x1b[0m";

const TERMINAL_PALETTE: PickPalette = {
  accent: (text) => `${ACCENT}${text}${RESET}`,
  dim: (text) => `${DIM}${text}${RESET}`,
  disabled: (text) => `${DISABLED}${text}${RESET}`,
};

const LIST_HEIGHT = 10;

/**
 * Clack skips recomputing its option list when the query looks unchanged; this
 * value no real query can hold forces the recompute.
 */
const TAB_SWITCH_SENTINEL = "\u0000";

let installedPickContext: PickContext | null = null;

export function setPickContext(
  context: PickContext | null,
): PickContext | null {
  const previous = installedPickContext;
  installedPickContext = context;
  return previous;
}

/**
 * Returns `unavailable` instead of throwing so callers in pipes or CI can fall
 * back to non-interactive output; distinct from `cancelled`.
 */
export async function pickItems(
  request: PickRequest,
  context: PickContext = installedPickContext ?? defaultPickContext(),
): Promise<PickOutcome> {
  const blocked = pickTerminalUnavailable(context);
  if (blocked) return { kind: "unavailable", reason: blocked };
  if (request.rows.length === 0) {
    return { kind: "unavailable", reason: "empty-shelf" };
  }
  return await context.prompt(request);
}

/**
 * Check before reading the data repo: building rows can refuse on unsafe
 * catalog names, which should fail `ls`/`add`, not a command that merely
 * offered a picker.
 */
export function pickTerminalUnavailable(
  context: PickContext = installedPickContext ?? defaultPickContext(),
): PickUnavailableReason | null {
  if (!context.stdinIsTTY || !context.stderrIsTTY) return "no-terminal";
  return (context.capableTerminal ?? true) ? null : "dumb-terminal";
}

interface PickOption {
  value: string;
  label: string;
}

interface PreviewPane {
  rowId: string;
  ref: string;
  query: string;
  state: "loading" | "ready" | "error";
  lines: string[];
  scroll: number;
}

/** Members `@clack/core` 1.4.3 has at runtime but keeps out of its types. */
interface ClackPromptInternals {
  rl?: { write(data: null, key: { ctrl: boolean; name: string }): void };
  render?: () => void;
}

/**
 * Members are optional so a clack release that drops one degrades to a no-op
 * instead of crashing.
 */
function clackInternals(
  prompt: AutocompletePrompt<PickOption> | ClackPromptInternals,
): ClackPromptInternals {
  // SAFETY: `rl` and `render` are `private` in @clack/core 1.4.3 types but
  // exist at runtime; the modifier hides them from the type, not the object.
  return prompt as ClackPromptInternals;
}

/**
 * `←/→` switch tabs, but readline still moves its insertion point.
 * `resetInputState` moves it to the end, then clears and rewrites the text, so
 * the next character lands at the end.
 */
class TypePickPrompt extends AutocompletePrompt<PickOption> {
  tabs: PickTab[];
  activeTab = 0;
  ranked: RankedPickRow[] = [];
  private allRows: PickRow[] | undefined;
  private kindOrder: readonly PickKind[] | undefined;
  private action: string | undefined;
  private previewProvider: ((row: PickRow) => Promise<PickPreview>) | undefined;
  private previewPane: PreviewPane | undefined;
  private previewVersions = new Map<string, string>();
  private renderedQuery: string | null = null;
  /**
   * Built lazily per tab so the copy-and-sort runs once per tab, not once per
   * keystroke.
   */
  private finders = new Map<string, PickFinder>();
  /**
   * Not `disabled: true` on options, because clack's cursor walk then skips the
   * row and its reason can never be focused or read; `toggleSelected` enforces
   * unmarkable.
   */
  private unmarkableIds = new Set<string>();

  constructor(opts: {
    rows: PickRow[];
    message: string;
    output: NodeJS.WriteStream;
    kindOrder?: readonly PickKind[];
    action?: string;
    preview?: (row: PickRow) => Promise<PickPreview>;
  }) {
    // These hooks must be `function`, not arrows, with nothing before
    // `super()`: arrows touching `this` threw in the compiled binary though
    // fine from source.
    super({
      multiple: true,
      output: opts.output,
      // Passes every option through: the options getter below already filtered
      // and ranked, so clack must not filter again.
      filter: () => true,
      options(this: AutocompletePrompt<PickOption>) {
        // SAFETY: clack calls this hook with the prompt as receiver, and only
        // `TypePickPrompt` is built with these hooks.
        return (this as TypePickPrompt).buildOptions();
      },
      render(this: AutocompletePrompt<PickOption>) {
        // SAFETY: the same receiver contract as `options` above.
        return (this as TypePickPrompt).frame(opts.message);
      },
    });
    this.allRows = opts.rows;
    this.kindOrder = opts.kindOrder;
    this.action = opts.action;
    this.previewProvider = opts.preview;
    this.tabs = pickTabs(opts.rows, opts.kindOrder);
    // Prime the list here: the base constructor calls `options` before this
    // subclass's fields exist, so it got an empty list.
    this.filteredOptions = this.buildOptions();
    // Start at index 0, where clack's private cursor starts, so the pointer and
    // arrow navigation stay in sync. A disabled first row is fine: its reason
    // shows, and Tab does nothing until the cursor reaches a markable row.
    this.focusedValue = this.filteredOptions[0]?.value;
    this.on("key", (_char, key) => this.onTypeKey(key));
  }

  protected override _shouldSubmit(
    char: string | undefined,
    key: Key,
  ): boolean {
    return this.previewPane === undefined && super._shouldSubmit(char, key);
  }

  override toggleSelected(value: string): void {
    // Optional chaining: the base constructor can call this before the field
    // initialisers run, and at that point nothing is unmarkable yet.
    if (this.previewPane || this.unmarkableIds?.has(value)) return;
    super.toggleSelected(value);
  }

  previewVersionsFor(refs: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      refs.flatMap((ref) => {
        const version = this.previewVersions.get(ref);
        return version === undefined ? [] : [[ref, version]];
      }),
    );
  }

  private buildOptions(): PickOption[] {
    // The base constructor calls this before subclass fields are initialised;
    // the constructor primes the list afterwards.
    if (this.allRows === undefined) return [];
    const query = this.userInput ?? "";
    // Clear `focusedValue` on query change: clack otherwise follows the
    // previously focused row, but a ranked list should put the best match at
    // the top.
    if (this.renderedQuery !== null && query !== this.renderedQuery) {
      this.focusedValue = undefined;
    }
    this.renderedQuery = query;

    const tab = this.tabs?.[this.activeTab]?.key ?? "all";
    let finder = this.finders?.get(tab);
    if (!finder) {
      finder = createPickFinder(rowsForTab(this.allRows, tab), this.kindOrder);
      this.finders?.set(tab, finder);
    }
    this.ranked = finder.find(query);
    this.unmarkableIds = new Set(
      this.ranked
        .filter((entry) => isPickRowDisabled(entry.row))
        .map((entry) => pickRowId(entry.row)),
    );
    // No `disabled` flag: clack would skip the row when moving the cursor, so
    // its reason could never be read.
    return this.ranked.map((entry) => ({
      // Use the row identity, not the label: a share catalog offers one mcp
      // server per output file, all with the same `ref`.
      value: pickRowId(entry.row),
      label: entry.row.ref,
    }));
  }

  private onTypeKey(key: Key): void {
    const name = key.name;
    // Ctrl-V, not Ctrl-D: `0x04` is EOF to readline, which closes and stops
    // delivering keys; readline doesn't own Ctrl-V.
    if (
      this.previewProvider &&
      name === "v" &&
      key.ctrl === true &&
      key.meta !== true
    ) {
      if (this.previewPane) this.closePreview();
      else this.openPreview();
      return;
    }
    if (this.previewPane) {
      if (name === "q" && key.ctrl !== true && key.meta !== true) {
        this.closePreview();
        return;
      }
      this.focusedValue = this.previewPane.rowId;
      const page = this.previewPageHeight();
      if (name === "up") this.previewPane.scroll--;
      else if (name === "down") this.previewPane.scroll++;
      else if (name === "pageup") this.previewPane.scroll -= page;
      else if (name === "pagedown") this.previewPane.scroll += page;
      else if (name === "home") this.previewPane.scroll = 0;
      else if (name === "end")
        this.previewPane.scroll = this.previewPane.lines.length;
      this.clampPreviewScroll();
      return;
    }
    if (name === "up" || name === "down") {
      // Clear `isNavigating` after arrows: clack treats Space as 'mark focused
      // row' while it is set, which swallows the space in queries and marks a
      // row.
      this.isNavigating = false;
      return;
    }
    if (name !== "left" && name !== "right") return;
    this.activeTab = stepTab(
      this.tabs.length,
      this.activeTab,
      name === "right" ? 1 : -1,
    );
    this.focusedValue = undefined;
    this.renderedQuery = null;
    this.resetInputState();
  }

  /**
   * The sentinel forces clack to recompute: it only rebuilds its list and
   * cursor when the input value changes, and a tab switch leaves the query as
   * it was.
   */
  private resetInputState(): void {
    const text = this.userInput;
    this.moveLineCursorToEnd();
    this._setUserInput(TAB_SWITCH_SENTINEL);
    this._clearUserInput();
    this._setUserInput(text, true);
  }

  private restoreInputState(text: string): void {
    this.moveLineCursorToEnd();
    this._setUserInput(TAB_SWITCH_SENTINEL);
    this._clearUserInput();
    this._setUserInput(text, true);
  }

  /**
   * Move to end before the clear: Ctrl-U deletes only left of the cursor, so
   * after `←` the suffix would survive.
   */
  private moveLineCursorToEnd(): void {
    clackInternals(this).rl?.write(null, { ctrl: true, name: "e" });
  }

  /**
   * Derived from `focusedValue`, the row `Tab` toggles, so the pointer and the
   * marked row can't disagree after a list rebuild.
   */
  private cursorFromFocus(): number {
    if (this.focusedValue === undefined) return -1;
    return this.ranked.findIndex(
      (entry) => pickRowId(entry.row) === this.focusedValue,
    );
  }

  private frame(message: string): string {
    if (this.previewPane) return this.previewFrame(this.previewPane);
    const body = renderPickBody({
      tabs: this.tabs ?? [],
      activeTab: this.activeTab,
      query: this.userInput ?? "",
      rows: this.ranked,
      cursor: this.cursorFromFocus(),
      marked: new Set(this.selectedValues),
      height: LIST_HEIGHT,
      // Width comes from stderr, where the frame is drawn; a non-terminal
      // stream has no width, which `bodyBudget` treats as unlimited.
      columns: process.stderr.columns,
      palette: TERMINAL_PALETTE,
      ...(this.action !== undefined && { action: this.action }),
      preview: this.previewProvider !== undefined,
    });
    // The header sits above already-fitted lines, so it gets the same budget;
    // `init` messages can wrap a 40-column terminal alone.
    const budget = bodyBudget(process.stderr.columns);
    const header = [...message].slice(0, budget).join("");
    return [
      `${TERMINAL_PALETTE.accent("◆")}  ${header}`,
      ...body.map((line) => `${TERMINAL_PALETTE.dim(GUTTER)}${line}`),
      TERMINAL_PALETTE.dim("└"),
    ].join("\n");
  }

  private openPreview(): void {
    const rowId = this.focusedValue;
    if (!rowId || !this.previewProvider) return;
    const row = this.ranked.find(
      (entry) => pickRowId(entry.row) === rowId,
    )?.row;
    if (!row) return;
    const pane: PreviewPane = {
      rowId,
      ref: row.ref,
      query: this.userInput ?? "",
      state: "loading",
      lines: [],
      scroll: 0,
    };
    this.previewPane = pane;
    this.previewVersions.delete(rowId);
    void this.previewProvider(row).then(
      (preview) => {
        if (this.previewPane !== pane) return;
        this.previewPane = {
          ...pane,
          state: "ready",
          lines: highlightTerminalDiff(preview.text),
        };
        if (preview.version !== undefined) {
          this.previewVersions.set(rowId, preview.version);
        }
        this.forceRedraw();
      },
      (cause: unknown) => {
        if (this.previewPane !== pane) return;
        const message =
          cause instanceof Error ? cause.message : "diff preview failed";
        this.previewPane = {
          ...pane,
          state: "error",
          lines: [sanitizeDisplayText(message)],
        };
        this.forceRedraw();
      },
    );
  }

  private closePreview(): void {
    const pane = this.previewPane;
    if (!pane) return;
    this.previewPane = undefined;
    this.focusedValue = pane.rowId;
    this.renderedQuery = null;
    this.restoreInputState(pane.query);
  }

  private previewFrame(pane: PreviewPane): string {
    this.clampPreviewScroll();
    const budget = bodyBudget(process.stderr.columns);
    const page = this.previewPageHeight();
    const sourceLines =
      pane.state === "loading"
        ? [`${TERMINAL_PALETTE.dim("loading diff…")}`]
        : pane.lines;
    const visible = sourceLines.slice(pane.scroll, pane.scroll + page);
    const end = Math.min(sourceLines.length, pane.scroll + page);
    const position =
      sourceLines.length > page
        ? `${pane.scroll + 1}-${end} of ${sourceLines.length}`
        : `${sourceLines.length} line${sourceLines.length === 1 ? "" : "s"}`;
    const title = truncateAnsiLine(`Diff: ${pane.ref}`, budget);
    const body = visible.map((line) => truncateAnsiLine(line, budget));
    while (body.length < page) body.push("");
    return [
      `${TERMINAL_PALETTE.accent("◆")}  ${title}`,
      ...body.map((line) => `${TERMINAL_PALETTE.dim(GUTTER)}${line}`),
      `${TERMINAL_PALETTE.dim(GUTTER)}${TERMINAL_PALETTE.dim(position)}`,
      `${TERMINAL_PALETTE.dim(GUTTER)}${TERMINAL_PALETTE.dim("↑/↓ scroll · PgUp/PgDn page · ctrl+v/q close · esc cancel")}`,
      TERMINAL_PALETTE.dim("└"),
    ].join("\n");
  }

  private previewPageHeight(): number {
    return Math.max(4, (process.stderr.rows ?? 20) - 4);
  }

  private clampPreviewScroll(): void {
    if (!this.previewPane) return;
    const max = Math.max(
      0,
      this.previewPane.lines.length - this.previewPageHeight(),
    );
    this.previewPane.scroll = Math.min(
      max,
      Math.max(0, this.previewPane.scroll),
    );
  }

  private forceRedraw(): void {
    // The preview resolves after the keypress redraw, so replacing the loading
    // pane needs this runtime seam.
    clackInternals(this).render?.();
  }
}

/**
 * `@clack/core` measures wrapping with `process.stdout.columns`, not its
 * `output`; with stdout redirected, redraws rewind too few lines, so borrow
 * stderr's width.
 */
export function borrowTerminalWidth(): () => void {
  // SAFETY: Node types `columns` as a number, but a redirected stdout has none
  // at runtime and the undo must restore `undefined`.
  const stdout = process.stdout as { columns?: number };
  if (stdout.columns !== undefined) return () => {};
  const sync = (): void => {
    stdout.columns = process.stderr.columns;
  };
  sync();
  // Follow terminal resizes, or the borrowed width goes stale and the rewind
  // drifts.
  process.stderr.on("resize", sync);
  return () => {
    process.stderr.off("resize", sync);
    stdout.columns = undefined;
  };
}

function defaultPickContext(): PickContext {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    capableTerminal: !isDumbTerminal(),
    prompt: async (request) => {
      const prompt = new TypePickPrompt({
        rows: request.rows,
        message: request.message,
        output: process.stderr,
        ...(request.kindOrder && { kindOrder: request.kindOrder }),
        ...(request.action !== undefined && { action: request.action }),
        ...(request.preview !== undefined && { preview: request.preview }),
      });
      const restoreWidth = borrowTerminalWidth();
      try {
        const answer = await prompt.prompt();
        if (isCancel(answer)) return { kind: "cancelled" };
        const refs = Array.isArray(answer) ? answer : [];
        const previewVersions = prompt.previewVersionsFor(refs);
        return {
          kind: "picked",
          refs,
          ...(Object.keys(previewVersions).length > 0 && { previewVersions }),
        };
      } finally {
        restoreWidth();
      }
    },
  };
}
