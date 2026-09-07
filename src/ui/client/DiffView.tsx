import type { ComponentChildren, RefObject } from "preact";
import { createPortal } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { DiffViewName, UiDiffResponse, UiItem } from "../shared/api-types";
import {
  type DiffFile,
  type DiffFileStat,
  fileStats,
  type ParsedDiff,
  parseUnifiedDiff,
  type SideCell,
  type SideRow,
  sideBySideRows,
  type ThreeCell,
  threeWayRows,
} from "../shared/diff-parse";
import { ApiError } from "./api";
import { highlightLine, languageForPath } from "./highlight";
import { Icon } from "./icons";

type Mode = DiffViewName | "three";

type Layout = "split" | "unified";

interface Loaded {
  state: "loading" | "ready" | "error";
  response: UiDiffResponse | null;
  error: string | null;
}

type LoadedViews = Record<DiffViewName, Loaded | undefined>;

/** Rows shown per file before the reader asks for more. */
const ROW_STEP = 400;

const NARROW = "(max-width: 800px)";

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Below the drawer breakpoint two code columns cannot hold a line. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = (): void => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

function caption(view: DiffViewName, unified: boolean): string {
  const other =
    view === "installed"
      ? "the installed copy"
      : "the shelf's committed version";
  return unified
    ? `Removed lines are the pin, added lines are ${other}.`
    : `Locked content on the left, ${other} on the right.`;
}

export function DiffView({
  item,
  loadDiff,
}: {
  item: UiItem;
  loadDiff: (view: DiffViewName) => Promise<UiDiffResponse>;
}): preact.JSX.Element {
  const both = item.diffViews.length === 2;
  const narrow = useNarrow();
  const [mode, setMode] = useState<Mode>(
    both ? "three" : (item.diffViews[0] ?? "installed"),
  );
  const [loaded, setLoaded] = useState<LoadedViews>({
    installed: undefined,
    upstream: undefined,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  // A phone shows one comparison at a time; three columns do not fit.
  const effectiveMode: Mode = narrow && mode === "three" ? "installed" : mode;

  // The summary needs every comparison the CLI offers, so both load at once.
  const needed: DiffViewName[] = item.diffViews;

  useEffect(() => {
    for (const view of needed) {
      if (loaded[view]) continue;
      setLoaded((previous) => ({
        ...previous,
        [view]: { state: "loading", response: null, error: null },
      }));
      loadDiff(view).then(
        (response) =>
          setLoaded((previous) => ({
            ...previous,
            [view]: { state: "ready", response, error: null },
          })),
        (cause: unknown) =>
          setLoaded((previous) => ({
            ...previous,
            [view]: {
              state: "error",
              response: null,
              error: cause instanceof ApiError ? cause.message : String(cause),
            },
          })),
      );
    }
  }, [needed, loaded, loadDiff]);

  const closeDialog = useCallback((): void => {
    setDialogOpen(false);
    openerRef.current?.focus();
  }, []);

  const openDialog = (next: Mode): void => {
    setMode(next);
    setDialogOpen(true);
  };

  return (
    <div class="diff">
      <DiffSummary
        views={item.diffViews}
        loaded={loaded}
        defaultMode={effectiveMode}
        openerRef={openerRef}
        onOpen={openDialog}
      />
      {dialogOpen
        ? createPortal(
            <DiffDialog
              item={item}
              both={both}
              narrow={narrow}
              mode={effectiveMode}
              onMode={setMode}
              loaded={loaded}
              onClose={closeDialog}
            />,
            document.body,
          )
        : null}
    </div>
  );
}

function DiffBody({
  mode,
  loaded,
  unified,
}: {
  mode: Mode;
  loaded: LoadedViews;
  unified: boolean;
}): preact.JSX.Element {
  return mode === "three" ? (
    <ThreeWay installed={loaded.installed} upstream={loaded.upstream} />
  ) : (
    <SingleView view={mode} loaded={loaded[mode]} unified={unified} />
  );
}

type Summary =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "none"; message: string }
  | {
      state: "ready";
      files: DiffFileStat[];
      notes: string[];
      note: string | null;
    };

function summarize(view: DiffViewName, loaded: Loaded | undefined): Summary {
  if (!loaded || loaded.state === "loading") return { state: "loading" };
  if (loaded.state === "error") {
    return { state: "error", message: loaded.error ?? "unknown error" };
  }
  const diff = loaded.response?.diff ?? null;
  if (diff === null) {
    return {
      state: "none",
      message: `The CLI has no ${view === "installed" ? "installed" : "shelf"} comparison for this state.`,
    };
  }
  if (diff.text === null) {
    return {
      state: "none",
      message: `Comparison unavailable: ${diff.unavailableReason ?? "no reason given"}`,
    };
  }
  const parsed = parseUnifiedDiff(diff.text);
  return {
    state: "ready",
    files: fileStats(parsed),
    notes: parsed.notes,
    note: diff.note ?? null,
  };
}

function viewLabel(view: DiffViewName): string {
  return view === "installed" ? "Installed copy" : "Shelf";
}

/** Files listed in the panel before the dialog shows every line. */
const FILE_LIMIT = 8;

/**
 * What changed, one line per file, in place of the diff itself. The full
 * comparison waits behind the button, so a panel stays short.
 */
function DiffSummary({
  views,
  loaded,
  defaultMode,
  openerRef,
  onOpen,
}: {
  views: DiffViewName[];
  loaded: LoadedViews;
  defaultMode: Mode;
  openerRef: RefObject<HTMLButtonElement>;
  onOpen: (mode: Mode) => void;
}): preact.JSX.Element {
  const summaries = views.map((view) => ({
    view,
    summary: summarize(view, loaded[view]),
  }));
  const ready = summaries.flatMap(({ view, summary }) =>
    summary.state === "ready" ? [{ view, ...summary }] : [],
  );
  const paths = [
    ...new Set(ready.flatMap((entry) => entry.files.map((file) => file.path))),
  ].sort();
  const shownPaths = paths.slice(0, FILE_LIMIT);
  const single = ready.length === 1 && views.length === 1 ? ready[0] : null;
  const added = single?.files.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed =
    single?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const notes = ready.flatMap((entry) => entry.notes);
  return (
    <section class="diff-summary" aria-label="Diff summary">
      <div class="diff-bar">
        <p class="diff-caption muted">
          {views.length === 2
            ? "Installed copy and shelf compared with the pin."
            : `${viewLabel(views[0] ?? "installed")} compared with the pin.`}
          {single && single.files.length > 1 ? (
            <>
              {` ${single.files.length} files, `}
              <span class="diff-summary-add">+{added}</span>{" "}
              <span class="diff-summary-del">−{removed}</span>.
            </>
          ) : null}
        </p>
        <button
          type="button"
          class="button diff-open"
          ref={openerRef}
          aria-haspopup="dialog"
          onClick={() => onOpen(defaultMode)}
        >
          <Icon name="expand" />
          <span>Open diff</span>
        </button>
      </div>
      {summaries.map(({ view, summary }) =>
        summary.state === "ready" ? null : (
          <p
            key={view}
            class={`diff-status ${summary.state === "error" ? "tone-attention" : "muted"}`}
          >
            {views.length === 2 ? `${viewLabel(view)}: ` : ""}
            {summary.state === "loading"
              ? "Comparing…"
              : summary.state === "error"
                ? `Comparison failed: ${summary.message}`
                : summary.message}
          </p>
        ),
      )}
      {ready.map((entry) =>
        entry.note ? (
          <p key={`${entry.view}-note`} class="diff-note muted">
            {entry.note}
          </p>
        ) : null,
      )}
      {ready.length > 0 && paths.length === 0 ? (
        <p class="diff-status muted">No content differences.</p>
      ) : null}
      {paths.length > 0 ? (
        <ul class="diff-summary-files">
          {shownPaths.map((path) => (
            <li key={path} class="diff-summary-file">
              <span class="mono diff-summary-path">{path || "(new file)"}</span>
              {ready.map((entry) => {
                const file = entry.files.find((stat) => stat.path === path);
                return (
                  <span key={entry.view} class="diff-summary-stat">
                    {ready.length === 2 ? (
                      <span class="muted">
                        {entry.view === "installed" ? "installed " : "shelf "}
                      </span>
                    ) : null}
                    {file ? (
                      <FileStatText stat={file} />
                    ) : (
                      <span class="muted">same</span>
                    )}
                  </span>
                );
              })}
            </li>
          ))}
          {paths.length > shownPaths.length ? (
            <li class="diff-summary-more muted">
              and {paths.length - shownPaths.length} more files
            </li>
          ) : null}
        </ul>
      ) : null}
      {notes.length > 0 ? (
        <ul class="diff-notes">
          {notes.map((note) => (
            <li key={note} class="mono">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function FileStatText({ stat }: { stat: DiffFileStat }): preact.JSX.Element {
  return (
    <>
      {stat.binary ? (
        <span class="muted">binary</span>
      ) : (
        <>
          <span class="diff-summary-add">+{stat.added}</span>{" "}
          <span class="diff-summary-del">−{stat.removed}</span>
        </>
      )}
      {stat.modeChange ? (
        <span class="muted"> · mode {stat.modeChange}</span>
      ) : null}
    </>
  );
}

function ComparisonModes({
  current,
  narrow,
  onSelect,
}: {
  current: Mode;
  narrow: boolean;
  onSelect: (mode: Mode) => void;
}): preact.JSX.Element {
  return (
    <fieldset class="diff-modes">
      <legend class="visually-hidden">Comparison</legend>
      <ModeButton value="installed" current={current} onSelect={onSelect}>
        Installed
      </ModeButton>
      <ModeButton value="upstream" current={current} onSelect={onSelect}>
        Shelf
      </ModeButton>
      {narrow ? null : (
        <ModeButton value="three" current={current} onSelect={onSelect}>
          Three-way
        </ModeButton>
      )}
    </fieldset>
  );
}

function ModeButton<Value extends string>({
  value,
  current,
  onSelect,
  disabled,
  title,
  children,
}: {
  value: Value;
  current: Value;
  onSelect: (value: Value) => void;
  disabled?: boolean | undefined;
  title?: string | undefined;
  children: ComponentChildren;
}): preact.JSX.Element {
  return (
    <button
      type="button"
      class={`mode-button${current === value ? " is-active" : ""}`}
      aria-pressed={current === value}
      disabled={disabled}
      title={title}
      onClick={() => onSelect(value)}
    >
      {children}
    </button>
  );
}

/**
 * The same comparison at the width of the window, with a layout choice.
 * The dialog renders at the document body, so no panel animation or
 * refresh fade can trap it, and it holds keyboard focus until it closes.
 */
function DiffDialog({
  item,
  both,
  narrow,
  mode,
  onMode,
  loaded,
  onClose,
}: {
  item: UiItem;
  both: boolean;
  narrow: boolean;
  mode: Mode;
  onMode: (mode: Mode) => void;
  loaded: LoadedViews;
  onClose: () => void;
}): preact.JSX.Element {
  const [layout, setLayout] = useState<Layout>(narrow ? "unified" : "split");
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = "diff-dialog-title";

  useEffect(() => {
    closeRef.current?.focus();
    document.body.classList.add("has-dialog");
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const outside = !dialogRef.current.contains(active);
      if (
        event.shiftKey
          ? active === first || outside
          : active === last || outside
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("has-dialog");
    };
  }, [onClose]);

  const shownLayout: Layout = narrow ? "unified" : layout;
  const unified = shownLayout === "unified" && mode !== "three";

  return (
    <div class="dialog-layer">
      <button
        type="button"
        class="dialog-scrim"
        aria-label="Close the diff"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        class="dialog diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
      >
        <header class="dialog-head">
          <h2 id={titleId} class="dialog-title">
            <span class="mono">{item.ref}</span>
            <span class="muted dialog-subtitle"> · {item.stateLabel}</span>
          </h2>
          {both ? (
            <ComparisonModes current={mode} narrow={narrow} onSelect={onMode} />
          ) : null}
          <fieldset class="diff-modes">
            <legend class="visually-hidden">Layout</legend>
            <ModeButton
              value="split"
              current={shownLayout}
              onSelect={setLayout}
              disabled={narrow}
              title={narrow ? "Too narrow for two columns" : undefined}
            >
              Side by side
            </ModeButton>
            <ModeButton
              value="unified"
              current={shownLayout}
              onSelect={setLayout}
              disabled={mode === "three"}
              title={
                mode === "three" ? "Three-way has no unified form" : undefined
              }
            >
              Unified
            </ModeButton>
          </fieldset>
          <button
            type="button"
            class="icon-button"
            ref={closeRef}
            aria-label="Close the diff"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <p class="diff-caption muted dialog-caption">
          {mode === "three"
            ? "Installed copy, locked content, and the shelf's committed version, aligned on the pinned lines."
            : caption(mode, unified)}
        </p>
        <div class="dialog-body">
          <DiffBody mode={mode} loaded={loaded} unified={unified} />
        </div>
      </div>
    </div>
  );
}

function SingleView({
  view,
  loaded,
  unified,
}: {
  view: DiffViewName;
  loaded: Loaded | undefined;
  unified: boolean;
}): preact.JSX.Element {
  if (!loaded || loaded.state === "loading") {
    return <p class="diff-status muted">Comparing…</p>;
  }
  if (loaded.state === "error") {
    return (
      <p class="diff-status tone-attention">
        Comparison failed: {loaded.error}
      </p>
    );
  }
  const response = loaded.response;
  if (!response || response.diff === null) {
    return (
      <p class="diff-status muted">
        The CLI has no {view === "installed" ? "installed" : "shelf"} comparison
        for this state.
      </p>
    );
  }
  const { diff } = response;
  if (diff.text === null) {
    return (
      <p class="diff-status muted">
        Comparison unavailable: {diff.unavailableReason ?? "no reason given"}
      </p>
    );
  }
  const parsed = parseUnifiedDiff(diff.text);
  if (parsed.files.length === 0 && parsed.notes.length === 0) {
    return <p class="diff-status muted">No content differences.</p>;
  }
  return (
    <div class="diff-files">
      {diff.note ? <p class="diff-note muted">{diff.note}</p> : null}
      {parsed.files.map((file) => (
        <DiffFileView
          key={`${file.oldLabel}|${file.newLabel}`}
          file={file}
          unified={unified}
        />
      ))}
      {parsed.notes.length > 0 ? (
        <ul class="diff-notes">
          {parsed.notes.map((note) => (
            <li key={note} class="mono">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FileHeader({ file }: { file: DiffFile }): preact.JSX.Element {
  return (
    <div class="diff-file-head">
      <span class="diff-file-path mono">{file.path || "(new file)"}</span>
      {file.oldMode && file.newMode ? (
        <span class="muted mono">
          {" "}
          mode {file.oldMode} → {file.newMode}
        </span>
      ) : null}
      {file.binary ? <span class="muted"> · binary files differ</span> : null}
    </div>
  );
}

type FileRow =
  | { hunk: true; header: string; key: string }
  | { hunk: false; row: SideRow; key: string };

function MoreButton({
  total,
  limit,
  onMore,
}: {
  total: number;
  limit: number;
  onMore: () => void;
}): preact.JSX.Element | null {
  if (total <= limit) return null;
  return (
    <button type="button" class="button diff-more" onClick={onMore}>
      Show {Math.min(ROW_STEP, total - limit)} more lines of {total - limit}
    </button>
  );
}

/**
 * The tables use a fixed layout, which takes column widths from the first
 * row. That row holds the spanning headers, so without a column group the
 * browser splits each header evenly and the number column grows to a
 * quarter of the table. The group pins every number column narrow.
 */
function Columns({ pairs }: { pairs: number }): preact.JSX.Element {
  return (
    <colgroup>
      {Array.from({ length: pairs }, (_, index) => (
        <>
          <col key={`n${index}`} class="diff-col-no" />
          <col key={`t${index}`} />
        </>
      ))}
    </colgroup>
  );
}

function DiffFileView({
  file,
  unified,
}: {
  file: DiffFile;
  unified: boolean;
}): preact.JSX.Element {
  const [limit, setLimit] = useState(ROW_STEP);
  const language = languageForPath(file.path);
  const rows: FileRow[] = file.hunks.flatMap((hunk, index) => [
    { hunk: true as const, header: hunk.header, key: `h${index}` },
    ...sideBySideRows(hunk).map((row, rowIndex) => ({
      hunk: false as const,
      row,
      key: `r${index}-${rowIndex}`,
    })),
  ]);
  const shown = rows.slice(0, limit);
  return (
    <section class="diff-file">
      <FileHeader file={file} />
      {file.hunks.length > 0 ? (
        unified ? (
          <UnifiedTable file={file} rows={shown} language={language} />
        ) : (
          <SideBySideTable file={file} rows={shown} language={language} />
        )
      ) : null}
      <MoreButton
        total={rows.length}
        limit={limit}
        onMore={() => setLimit((current) => current + ROW_STEP)}
      />
      {file.notes.length > 0 ? (
        <ul class="diff-notes">
          {file.notes.map((note) => (
            <li key={note} class="mono">
              {note}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function SideBySideTable({
  file,
  rows,
  language,
}: {
  file: DiffFile;
  rows: FileRow[];
  language: ReturnType<typeof languageForPath>;
}): preact.JSX.Element {
  return (
    <table class="diff-table two">
      <Columns pairs={2} />
      <thead>
        <tr>
          <th scope="col" colSpan={2}>
            {file.oldSide || "locked"}
          </th>
          <th scope="col" colSpan={2}>
            {file.newSide || "current"}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((entry) =>
          entry.hunk ? (
            <tr key={entry.key} class="diff-hunk">
              <td colSpan={4} class="mono">
                {entry.header}
              </td>
            </tr>
          ) : (
            <tr key={entry.key} class={entry.row.changed ? "is-change" : ""}>
              <Cell cell={entry.row.left} language={language} />
              <Cell cell={entry.row.right} language={language} />
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

/**
 * One column: a changed pair becomes a removed line and an added line, the
 * way `status --diff` prints them. One number column: the new line number,
 * or the old one for a removed line.
 */
function UnifiedTable({
  file,
  rows,
  language,
}: {
  file: DiffFile;
  rows: FileRow[];
  language: ReturnType<typeof languageForPath>;
}): preact.JSX.Element {
  return (
    <table class="diff-table unified">
      <Columns pairs={1} />
      <thead>
        <tr>
          <th scope="col" colSpan={2}>
            {file.oldSide || "locked"} → {file.newSide || "current"}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.flatMap((entry) => {
          if (entry.hunk) {
            return [
              <tr key={entry.key} class="diff-hunk">
                <td colSpan={2} class="mono">
                  {entry.header}
                </td>
              </tr>,
            ];
          }
          const { left, right, changed } = entry.row;
          if (!changed && left) {
            return [
              <tr key={entry.key}>
                <td class="diff-no is-same">{right?.no ?? left.no ?? ""}</td>
                <UnifiedText cell={left} language={language} />
              </tr>,
            ];
          }
          const out: preact.JSX.Element[] = [];
          if (left) {
            out.push(
              <tr key={`${entry.key}-del`} class="is-change">
                <td class="diff-no is-del">{left.no ?? ""}</td>
                <UnifiedText cell={left} language={language} />
              </tr>,
            );
          }
          if (right) {
            out.push(
              <tr key={`${entry.key}-add`} class="is-change">
                <td class="diff-no is-add">{right.no ?? ""}</td>
                <UnifiedText cell={right} language={language} />
              </tr>,
            );
          }
          return out;
        })}
      </tbody>
    </table>
  );
}

function UnifiedText({
  cell,
  language,
}: {
  cell: SideCell;
  language: ReturnType<typeof languageForPath>;
}): preact.JSX.Element {
  const kind = cell.kind === "context" ? "same" : cell.kind;
  return (
    <td class={`diff-text is-${kind}`}>
      <span class="diff-marker" aria-hidden="true">
        {cell.kind === "add" ? "+" : cell.kind === "del" ? "-" : " "}
      </span>
      <span class="diff-code">{highlightLine(cell.text, language)}</span>
      {cell.noNewline ? (
        <span class="diff-nonl muted"> (no newline at end of file)</span>
      ) : null}
    </td>
  );
}

function Cell({
  cell,
  language,
}: {
  cell: SideCell | null;
  language: ReturnType<typeof languageForPath>;
}): preact.JSX.Element {
  if (cell === null) {
    return (
      <>
        <td class="diff-no is-empty" />
        <td class="diff-text is-empty" />
      </>
    );
  }
  const kind = cell.kind === "context" ? "same" : cell.kind;
  return (
    <>
      <td class={`diff-no is-${kind}`}>{cell.no ?? ""}</td>
      <UnifiedText cell={cell} language={language} />
    </>
  );
}

function ThreeWay({
  installed,
  upstream,
}: {
  installed: Loaded | undefined;
  upstream: Loaded | undefined;
}): preact.JSX.Element {
  if (
    !installed ||
    !upstream ||
    installed.state === "loading" ||
    upstream.state === "loading"
  ) {
    return (
      <p class="diff-status muted">Comparing installed, locked, and shelf…</p>
    );
  }
  const failures = [installed, upstream]
    .filter((entry) => entry.state === "error")
    .map((entry) => entry.error);
  if (failures.length > 0) {
    return (
      <p class="diff-status tone-attention">
        Comparison failed: {failures.join("; ")}
      </p>
    );
  }
  const left = parsedOrNull(installed);
  const right = parsedOrNull(upstream);
  const unavailable = [
    installed.response?.diff?.text === null
      ? `installed: ${installed.response.diff.unavailableReason ?? "unavailable"}`
      : null,
    upstream.response?.diff?.text === null
      ? `shelf: ${upstream.response.diff.unavailableReason ?? "unavailable"}`
      : null,
  ].filter((entry) => entry !== null);
  const paths = new Set<string>([
    ...(left?.files.map((file) => file.path) ?? []),
    ...(right?.files.map((file) => file.path) ?? []),
  ]);
  if (paths.size === 0) {
    return (
      <p class="diff-status muted">
        {unavailable.length > 0
          ? unavailable.join(" · ")
          : "No content differences."}
      </p>
    );
  }
  const shelfSide =
    right?.files[0]?.newSide ||
    upstream.response?.diff?.to.sourceCommit?.slice(0, 7) ||
    "shelf";
  return (
    <div class="diff-files">
      {unavailable.length > 0 ? (
        <p class="diff-note muted">{unavailable.join(" · ")}</p>
      ) : null}
      {upstream.response?.diff?.note ? (
        <p class="diff-note muted">{upstream.response.diff.note}</p>
      ) : null}
      {[...paths].sort().map((path) => (
        <ThreeWayFile
          key={path}
          path={path}
          installed={left?.files.find((file) => file.path === path) ?? null}
          shelf={right?.files.find((file) => file.path === path) ?? null}
          shelfSide={shelfSide}
        />
      ))}
    </div>
  );
}

function parsedOrNull(loaded: Loaded): ParsedDiff | null {
  const text = loaded.response?.diff?.text;
  if (text === null || text === undefined) return null;
  return parseUnifiedDiff(text);
}

function ThreeWayFile({
  path,
  installed,
  shelf,
  shelfSide,
}: {
  path: string;
  installed: DiffFile | null;
  shelf: DiffFile | null;
  shelfSide: string;
}): preact.JSX.Element {
  const [limit, setLimit] = useState(ROW_STEP);
  const language = languageForPath(path);
  const rows = threeWayRows(installed, shelf);
  const shown = rows.slice(0, limit);
  const binary = installed?.binary || shelf?.binary;
  const lockedSide = installed?.oldSide || shelf?.oldSide || "locked";
  return (
    <section class="diff-file">
      <div class="diff-file-head">
        <span class="diff-file-path mono">{path || "(new file)"}</span>
        {binary ? <span class="muted"> · binary files differ</span> : null}
        {installed === null ? (
          <span class="muted"> · installed copy matches the pin here</span>
        ) : null}
        {shelf === null ? (
          <span class="muted"> · shelf matches the pin here</span>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <table class="diff-table three">
          <Columns pairs={3} />
          <thead>
            <tr>
              <th scope="col" colSpan={2}>
                installed
              </th>
              <th scope="col" colSpan={2}>
                {lockedSide}
              </th>
              <th scope="col" colSpan={2}>
                {shelfSide}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) =>
              row.kind === "gap" ? (
                <tr key={`g${index}`} class="diff-hunk">
                  <td colSpan={6} class="mono">
                    …
                  </td>
                </tr>
              ) : (
                <tr
                  key={`r${index}`}
                  class={
                    row.installed?.kind !== "same" ||
                    row.shelf?.kind !== "same" ||
                    row.locked === null
                      ? "is-change"
                      : ""
                  }
                >
                  <ThreeCellView cell={row.installed} language={language} />
                  <ThreeCellView cell={row.locked} language={language} />
                  <ThreeCellView cell={row.shelf} language={language} />
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : null}
      <MoreButton
        total={rows.length}
        limit={limit}
        onMore={() => setLimit((current) => current + ROW_STEP)}
      />
    </section>
  );
}

function ThreeCellView({
  cell,
  language,
}: {
  cell: ThreeCell | null;
  language: ReturnType<typeof languageForPath>;
}): preact.JSX.Element {
  if (cell === null) {
    return (
      <>
        <td class="diff-no is-empty" />
        <td class="diff-text is-empty" />
      </>
    );
  }
  return (
    <>
      <td class={`diff-no is-${cell.kind}`}>{cell.no ?? ""}</td>
      <td class={`diff-text is-${cell.kind}`}>
        <span class="diff-marker" aria-hidden="true">
          {cell.kind === "add" ? "+" : cell.kind === "del" ? "-" : " "}
        </span>
        <span class="diff-code">{highlightLine(cell.text, language)}</span>
      </td>
    </>
  );
}
