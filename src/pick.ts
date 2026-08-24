/**
 * The terminal shell around `pick-core.ts`: an fzf-style filter list, grouped
 * by item type, where the user types to narrow, `←/→` switch type, `Tab`
 * marks, and `Enter` installs the marked rows.
 *
 * This drives `@clack/core`'s `AutocompletePrompt` directly rather than
 * `@clack/prompts`' `autocompleteMultiselect`. The wrapper renders a flat
 * option list and takes no `render` hook, so a type menu across the top cannot
 * be drawn through it. The core class takes `render`, which returns the whole
 * frame, and still supplies what is genuinely hard: raw mode, keypress
 * decoding, redraw diffing, and the cancel path. Every line the frame contains
 * is built as plain strings in `pick-frame.ts`.
 *
 * The prompt draws on stderr, never stdout. Every capshelf command keeps
 * stdout for its result — `--json` above all — and a prompt that scribbled on
 * it would break the pipe that a script reads.
 *
 * `setPickContext` is the same seam `destructive-change.ts` uses for its
 * consent prompt: the one way to exercise this path in a test without a
 * pseudo-terminal, while the shipped code still runs the real prompt.
 */
import { AutocompletePrompt, isCancel } from "@clack/core";
import { createPickFinder } from "./pick-core";
import type { PickRow, RankedPickRow } from "./pick-core";
import { GUTTER, bodyBudget, renderPickBody } from "./pick-frame";
import type { PickPalette } from "./pick-frame";
import { pickTabs, rowsForTab, stepTab } from "./pick-tabs";
import type { PickTab } from "./pick-tabs";

export interface PickRequest {
  rows: PickRow[];
  /** The question above the list. */
  message: string;
}

/** Why a picker could not be shown. A code, not prose, so callers can branch. */
export type PickUnavailableReason =
  | "no-terminal"
  | "dumb-terminal"
  | "empty-shelf";

export type PickOutcome =
  | { kind: "picked"; refs: string[] }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: PickUnavailableReason };

/** The message for an unavailable picker, phrased for a human. */
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
 * Whether `TERM` declares a terminal that cannot run a full-screen prompt.
 *
 * `dumb` is the standard way to say "no capabilities", and the prompt needs
 * more than none. Measured on one: `readline` ignores the key argument to its
 * own `write`, so the clear that restores the query never happens and typing
 * `re`, `←`, `v` left `rerev`, while `Tab` arrived as a literal tab character
 * instead of marking a row. Refusing gives the same clear message an absent
 * terminal does; rendering anyway gives a prompt that silently does the wrong
 * thing.
 */
function isDumbTerminal(term = process.env.TERM): boolean {
  return term === undefined || term === "" || term === "dumb";
}

export interface PickContext {
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  /**
   * Whether the terminal can run a full-screen prompt. Absent means yes, so an
   * injected context never depends on the ambient `TERM`; the real context
   * sets it from `TERM`.
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

/** List lines to draw, leaving room for the bar, the search line, and the legend. */
const LIST_HEIGHT = 10;

/**
 * A value no query can hold, used to force clack to recompute a list it
 * believes is unchanged. See `resetInputState`.
 */
const TAB_SWITCH_SENTINEL = "\u0000";

let installedPickContext: PickContext | null = null;

/**
 * Replace the picker context, or restore the default with `null`. Returns the
 * context that was installed before, so a caller can restore it instead of
 * clobbering an outer one.
 */
export function setPickContext(
  context: PickContext | null,
): PickContext | null {
  const previous = installedPickContext;
  installedPickContext = context;
  return previous;
}

/**
 * Offer the shelf and return the refs the user marked.
 *
 * Never throws for an absent terminal: a picker is an offer, and a caller in a
 * pipe or a CI job must be able to carry on with its non-interactive output.
 * `unavailable` is that answer, and it is distinct from `cancelled`, which
 * means a user saw the list and declined.
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
 * Whether a terminal exists, without needing any rows.
 *
 * Callers ask this *before* reading the data repo. Building the row list walks
 * the whole shelf and parses every sidecar, and that walk can legitimately
 * refuse — an unsafe item name in the catalog is a trust boundary `ls` and
 * `add` are right to fail on. Doing that work behind an offer nobody can see
 * turns a refusal that belongs to `ls` into a failure of whatever command
 * merely tried to be helpful.
 */
export function pickTerminalUnavailable(
  context: PickContext = installedPickContext ?? defaultPickContext(),
): PickUnavailableReason | null {
  if (!context.stdinIsTTY || !context.stderrIsTTY) return "no-terminal";
  // Defaults to capable, so an injected context never depends on the ambient
  // `TERM`. The real context below reports what `TERM` actually says.
  return (context.capableTerminal ?? true) ? null : "dumb-terminal";
}

interface PickOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * The prompt: a type menu, a ranked list, and a caret that stays at the end.
 *
 * `←/→` are rebound from moving the text caret to switching type. Node's
 * `readline` owns the insertion point and still moves it on those keys, so
 * without `restoreCaret` the next character would land wherever the caret
 * stopped — typing `ab`, pressing `←`, then `x` produced `axb`. Clearing and
 * rewriting the same text through the two protected hooks puts the insertion
 * point back at the end without reaching into `readline` itself.
 */
class TypePickPrompt extends AutocompletePrompt<PickOption> {
  tabs: PickTab[];
  activeTab = 0;
  /** Ranked rows behind the current options, for the frame to draw. */
  ranked: RankedPickRow[] = [];
  /** Every row on the shelf; each tab is a view of these. */
  private allRows: PickRow[] | undefined;
  /** The query the option list was last built for; see `buildOptions`. */
  private renderedQuery: string | null = null;

  constructor(opts: {
    rows: PickRow[];
    message: string;
    output: NodeJS.WriteStream;
  }) {
    // These two hooks must be `function`, not arrows, and nothing may precede
    // `super()`.
    //
    // An arrow here closes over the derived `this`, which does not exist until
    // `super()` returns, and an earlier version used a `let self` alias before
    // the call for the same purpose. Both forms threw "'super()' must be
    // called in derived constructor before accessing |this|" in the compiled
    // binary while running fine from source, so only the end-to-end layer
    // caught it. `AutocompletePrompt` invokes both hooks with the prompt as
    // their receiver, so a plain method reads `this` correctly.
    super({
      multiple: true,
      output: opts.output,
      // Replaces clack's substring default, which it applies even to a custom
      // option getter. The getter below already filtered and ranked, so this
      // passes its result through untouched.
      filter: () => true,
      options(this: AutocompletePrompt<PickOption>) {
        return (this as TypePickPrompt).buildOptions();
      },
      render(this: AutocompletePrompt<PickOption>) {
        return (this as TypePickPrompt).frame(opts.message);
      },
    });
    this.allRows = opts.rows;
    this.tabs = pickTabs(opts.rows);
    // Prime the list. The base constructor reads `options` before any of this
    // subclass's fields exist, so it got an empty list and focused nothing.
    // Without this the first frame is blank until the user types.
    this.filteredOptions = this.buildOptions();
    this.focusedValue = this.filteredOptions.find(
      (option) => !option.disabled,
    )?.value;
    this.on("key", (_char, key) => this.onTypeKey(key?.name));
  }

  private buildOptions(): PickOption[] {
    // The base constructor calls this once, before this subclass's field
    // initialisers have run, so there is nothing to build yet. The constructor
    // primes the list itself immediately afterwards.
    if (this.allRows === undefined) return [];
    const query = this.userInput ?? "";
    // Snap the cursor to the best match whenever the query changes.
    //
    // clack keeps the cursor on whatever row was focused before, by looking it
    // up in the newly filtered list and following it to its new position. That
    // is right for a static list. It is wrong for a ranked one: typing exists
    // to bring the best match to the top, and the row focused a keystroke ago
    // is usually not it. Clearing `focusedValue` makes clack's lookup fall
    // through to index 0. Marks live in `selectedValues` and are untouched.
    if (this.renderedQuery !== null && query !== this.renderedQuery) {
      this.focusedValue = undefined;
    }
    this.renderedQuery = query;

    const tab = this.tabs?.[this.activeTab]?.key ?? "all";
    this.ranked = createPickFinder(rowsForTab(this.allRows, tab)).find(query);
    return this.ranked.map((entry) => ({
      value: entry.row.ref,
      label: entry.row.ref,
      ...(entry.row.installed && { disabled: true }),
    }));
  }

  private onTypeKey(name: string | undefined): void {
    if (name === "up" || name === "down") {
      // Leave navigation mode as soon as the arrow is handled.
      //
      // `AutocompletePrompt` treats Space as "mark the focused row" while
      // `isNavigating` is set, which `↑`/`↓` set. That silently breaks the
      // documented query syntax and installs things nobody chose: typing
      // `sec`, pressing `↓`, then Space and `rev` swallowed the separator,
      // leaving `secrev`, and marked whichever row happened to be focused.
      // Enter then installed it. Clearing the flag here — after the base
      // handler has moved the cursor, before the next key — makes Space
      // ordinary text again. Tab still marks, because it does not consult
      // this flag.
      this.isNavigating = false;
      return;
    }
    if (name !== "left" && name !== "right") return;
    this.activeTab = stepTab(
      this.tabs.length,
      this.activeTab,
      name === "right" ? 1 : -1,
    );
    // A different tab is a different row set, so the cursor belongs at its top.
    this.focusedValue = undefined;
    this.renderedQuery = null;
    this.resetInputState();
  }

  /**
   * Rebuild the row list and the cursor after a tab change, and put the text
   * insertion point back at the end.
   *
   * Both halves are needed, and the sentinel is what makes the first one work.
   * clack recomputes its filtered list and its internal cursor only when the
   * *value* of the input changes, and switching tab usually leaves the query
   * exactly as it was — so the new tab's rows were never built, and the frame
   * drew the previous tab's list under the new tab's heading, counting `6 of
   * 1`. Passing a value no query can equal forces that recomputation; the two
   * calls after it restore the real query. No frame is drawn in between.
   *
   * The write also fixes the caret. `readline` owns the insertion point and
   * still moves it on `←`/`→`, so without rewriting the text the next
   * character would land where the caret stopped: typing `ab`, pressing `←`,
   * then `x` produced `axb`.
   */
  private resetInputState(): void {
    const text = this.userInput;
    this.moveLineCursorToEnd();
    this._setUserInput(TAB_SWITCH_SENTINEL);
    this._clearUserInput();
    this._setUserInput(text, true);
  }

  /**
   * Put `readline`'s own insertion point at the end of the line.
   *
   * This has to happen before `_clearUserInput`, which sends Ctrl-U — and
   * Ctrl-U deletes only what is left of the cursor. After a `←` the cursor sits
   * inside the query, so the suffix survived the clear and the rewrite landed
   * in front of it: typing `ab`, pressing `←`, then `x` produced `abxb`. An
   * earlier check used `→`, which is a no-op at the end of the text, and so
   * never exercised the failing direction.
   *
   * `Prompt` keeps its readline instance private and offers no accessor, so
   * this reaches it through a narrow structural type rather than `any`, and
   * does nothing if the shape ever changes.
   */
  private moveLineCursorToEnd(): void {
    const host = this as unknown as {
      rl?: { write(data: null, key: { ctrl: boolean; name: string }): void };
    };
    host.rl?.write(null, { ctrl: true, name: "e" });
  }

  /**
   * The index the pointer is drawn at, taken from `focusedValue` rather than
   * clack's cursor.
   *
   * `focusedValue` is the row `Tab` toggles, so deriving the pointer from it
   * makes the marked row provably the pointed-at one. Reading the numeric
   * cursor instead lets the two disagree whenever the list is rebuilt.
   */
  private cursorFromFocus(): number {
    if (this.focusedValue === undefined) return -1;
    return this.ranked.findIndex(
      (entry) => entry.row.ref === this.focusedValue,
    );
  }

  private frame(message: string): string {
    const body = renderPickBody({
      tabs: this.tabs ?? [],
      activeTab: this.activeTab,
      query: this.userInput ?? "",
      rows: this.ranked,
      cursor: this.cursorFromFocus(),
      marked: new Set(this.selectedValues),
      height: LIST_HEIGHT,
      // The stream the frame is drawn on decides how wide a line may be. A
      // stream that is not a terminal has no width, and `bodyBudget` reads
      // that as unlimited.
      columns: process.stderr.columns,
      palette: TERMINAL_PALETTE,
    });
    // The header sits above lines the frame already fitted, so it answers to
    // the same budget. `init` supplies a message long enough to wrap a
    // 40-column terminal on its own.
    const budget = bodyBudget(process.stderr.columns);
    const header = [...message].slice(0, budget).join("");
    return [
      `${TERMINAL_PALETTE.accent("◆")}  ${header}`,
      ...body.map((line) => `${TERMINAL_PALETTE.dim(GUTTER)}${line}`),
      TERMINAL_PALETTE.dim("└"),
    ].join("\n");
  }
}

/**
 * Lend `process.stdout` the terminal's width for the duration of the prompt,
 * and return the undo.
 *
 * `@clack/core` 1.4.3 measures line wrapping and cursor rewind with
 * `process.stdout.columns` (`dist/index.mjs`), not with the `output` stream it
 * was given. This prompt draws on stderr on purpose, so `capshelf add >
 * out.txt` leaves that number undefined while the terminal is on stderr, and
 * every redraw then rewinds too few lines. Measured on a 40-column terminal:
 * 49 lines rewound with stdout on the terminal against 40 with it redirected,
 * leaving nine wrapped rows of the previous frame on screen each keystroke.
 *
 * Refusing that invocation was the alternative. Writing the result to a file
 * while picking on the terminal is exactly what drawing on stderr is for, so
 * the width is borrowed instead, and only when stdout has none of its own.
 */
export function borrowTerminalWidth(): () => void {
  const stdout = process.stdout as { columns?: number };
  if (stdout.columns !== undefined) return () => {};
  const sync = (): void => {
    stdout.columns = process.stderr.columns;
  };
  sync();
  // A resize mid-prompt changes the terminal, not the redirected stdout, so
  // the borrowed value has to follow it or the rewind drifts again.
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
      });
      const restoreWidth = borrowTerminalWidth();
      try {
        const answer = await prompt.prompt();
        if (isCancel(answer)) return { kind: "cancelled" };
        return { kind: "picked", refs: Array.isArray(answer) ? answer : [] };
      } finally {
        restoreWidth();
      }
    },
  };
}
