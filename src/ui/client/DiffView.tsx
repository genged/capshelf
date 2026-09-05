import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { DiffViewName, UiDiffResponse, UiItem } from "../shared/api-types";
import {
  type DiffFile,
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

type Mode = DiffViewName | "three";

interface Loaded {
  state: "loading" | "ready" | "error";
  response: UiDiffResponse | null;
  error: string | null;
}

/** Rows shown per file before the reader asks for more. */
const ROW_STEP = 400;

const NARROW = "(max-width: 800px)";

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
  const [loaded, setLoaded] = useState<
    Record<DiffViewName, Loaded | undefined>
  >({
    installed: undefined,
    upstream: undefined,
  });
  // A phone shows one comparison at a time; three columns do not fit.
  const effectiveMode: Mode = narrow && mode === "three" ? "installed" : mode;

  const needed: DiffViewName[] =
    effectiveMode === "three" ? ["installed", "upstream"] : [effectiveMode];

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
        (error: unknown) =>
          setLoaded((previous) => ({
            ...previous,
            [view]: {
              state: "error",
              response: null,
              error: error instanceof ApiError ? error.message : String(error),
            },
          })),
      );
    }
  }, [needed, loaded, loadDiff]);

  return (
    <div class="diff">
      {both ? (
        <fieldset class="diff-modes">
          <legend class="visually-hidden">Comparison</legend>
          <ModeButton
            mode="installed"
            current={effectiveMode}
            onSelect={setMode}
          >
            Installed
          </ModeButton>
          <ModeButton
            mode="upstream"
            current={effectiveMode}
            onSelect={setMode}
          >
            Shelf
          </ModeButton>
          {narrow ? null : (
            <ModeButton mode="three" current={effectiveMode} onSelect={setMode}>
              Three-way
            </ModeButton>
          )}
        </fieldset>
      ) : (
        <p class="diff-caption muted">
          {effectiveMode === "installed"
            ? narrow
              ? "Removed lines are the pin, added lines are the installed copy."
              : "Locked content on the left, the installed copy on the right."
            : narrow
              ? "Removed lines are the pin, added lines are the shelf's committed version."
              : "Locked content on the left, the shelf's committed version on the right."}
        </p>
      )}
      {effectiveMode === "three" ? (
        <ThreeWay installed={loaded.installed} upstream={loaded.upstream} />
      ) : (
        <SingleView
          view={effectiveMode}
          loaded={loaded[effectiveMode]}
          unified={narrow}
        />
      )}
    </div>
  );
}

function ModeButton({
  mode,
  current,
  onSelect,
  children,
}: {
  mode: Mode;
  current: Mode;
  onSelect: (mode: Mode) => void;
  children: ComponentChildren;
}): preact.JSX.Element {
  return (
    <button
      type="button"
      class={`mode-button${current === mode ? " is-active" : ""}`}
      aria-pressed={current === mode}
      onClick={() => onSelect(mode)}
    >
      {children}
    </button>
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
 * One column for narrow screens: a changed pair becomes a removed line and
 * an added line, the way `status --diff` prints them. One number column:
 * the new line number, or the old one for a removed line.
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
