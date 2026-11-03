import type { ComponentChildren } from "preact";
import type { UiShelfFacts } from "../shared/api-types";
import type { TreeEntry } from "../shared/view-model";
import { splitDisplayPath } from "../shared/view-model";
import { Icon } from "./icons";

/**
 * The left rail: every registered project, attention first, with the folder
 * name first because it tells projects apart. The foot names the shelf and
 * the CLI. A phone gets a picker instead (`RailPicker`).
 */
export function ProjectRail({
  entries,
  selectedPath,
  shelf,
  cliVersion,
  onSelect,
  top,
}: {
  entries: TreeEntry[];
  selectedPath: string | null;
  shelf: UiShelfFacts | null;
  cliVersion: string | null;
  onSelect: (path: string) => void;
  /** Rows above the project list, such as All findings. */
  top?: ComponentChildren;
}): preact.JSX.Element {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const current = event.currentTarget;
    if (!(current instanceof HTMLElement)) return;
    const rows = Array.from(
      current
        .closest(".rail")
        ?.querySelectorAll<HTMLElement>(".rail-row[data-rail-row]") ?? [],
    );
    const index = rows.indexOf(current);
    if (index === -1) return;
    event.preventDefault();
    rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <nav class="rail" aria-label="Projects">
      {top}
      <h2 class="rail-head">Projects</h2>
      {entries.length === 0 ? (
        <p class="rail-head muted">No projects registered.</p>
      ) : (
        <ul class="rail-list">
          {entries.map((entry) => {
            const { name, parent } = splitDisplayPath(entry.display);
            const selected = entry.path === selectedPath;
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  data-rail-row
                  class={`rail-row${entry.state === "missing" ? " is-missing" : ""}`}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect(entry.path)}
                  onKeyDown={onKeyDown}
                  title={entry.path}
                >
                  <span class="rail-row-name">{name}</span>
                  <RailCount entry={entry} />
                  <span class="rail-row-parent">{parent}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div class="rail-foot">
        {shelf ? (
          <span>
            Shelf{" "}
            <a
              class="mono"
              href={`#/shelf/${encodeURIComponent(shelf.dataRepo)}`}
              title={shelf.dataRepo}
            >
              {splitDisplayPath(shelf.display).name}
            </a>
            {shelf.headShort ? (
              <>
                {" @ "}
                <span class="mono">{shelf.headShort}</span>
              </>
            ) : null}
            {shelf.clean ? null : (
              <span class="tone-attention"> · uncommitted changes</span>
            )}
          </span>
        ) : null}
        {cliVersion ? <span>capshelf {cliVersion}</span> : null}
      </div>
    </nav>
  );
}

/** A count pill with a word for assistive technology beside the number. */
export function RailCount({ entry }: { entry: TreeEntry }): preact.JSX.Element {
  if (entry.state === "missing") {
    return <span class="count is-attention">missing</span>;
  }
  if (entry.state === "error") {
    return <span class="count is-attention">error</span>;
  }
  if (entry.counts === null) {
    return (
      <span class="count">
        <span class="skeleton-dot" />
        <span class="visually-hidden">loading</span>
      </span>
    );
  }
  const { items, attention } = entry.counts;
  if (attention === 0) {
    return (
      <span
        class="count is-ok"
        title={`${items} ${items === 1 ? "item" : "items"}, none needs attention`}
      >
        <Icon name="check" />
        <span class="visually-hidden">
          {items} {items === 1 ? "item" : "items"}, none needs attention
        </span>
      </span>
    );
  }
  return (
    <span
      class="count is-attention"
      title={`${attention} of ${items} ${items === 1 ? "item needs" : "items need"} attention`}
    >
      {attention}
      <span class="visually-hidden">
        {" "}
        of {items} {items === 1 ? "item needs" : "items need"} attention
      </span>
    </span>
  );
}

/** The select value that stands for All findings; no project path is empty. */
const FINDINGS_VALUE = "";

/**
 * The phone's stand-in for the rail: one select over All findings and the
 * projects. A null `selectedPath` selects All findings.
 */
export function RailPicker({
  entries,
  selectedPath,
  findings,
  onSelect,
  onFindings,
}: {
  entries: TreeEntry[];
  selectedPath: string | null;
  findings: number;
  onSelect: (path: string) => void;
  onFindings: () => void;
}): preact.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <label class="rail-picker">
      <Icon name="folder" />
      <span>View</span>
      <select
        value={selectedPath ?? FINDINGS_VALUE}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === FINDINGS_VALUE) onFindings();
          else onSelect(value);
        }}
      >
        <option value={FINDINGS_VALUE}>All findings ({findings})</option>
        {entries.map((entry) => {
          const attention = entry.counts?.attention ?? 0;
          return (
            <option key={entry.path} value={entry.path}>
              {splitDisplayPath(entry.display).name}
              {attention > 0 ? ` (${attention} need attention)` : ""}
            </option>
          );
        })}
      </select>
    </label>
  );
}
