import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { rankRows } from "../../pick-rank";
import {
  JUMP_GROUPS,
  type JumpRow,
  type JumpTarget,
} from "../shared/view-model";
import { copyText } from "./copy";
import { Icon } from "./icons";
import { HighlightedRef } from "./ShelfView";

/** Rows each group shows, so one long group cannot hide the others. */
const GROUP_LIMIT = 6;

interface Shown {
  row: JumpRow;
  positions: number[];
}

/**
 * Jump to any finding, project, item, shelf item, or user-level skill. The
 * picker's own ranking orders the matches. Enter opens the active row.
 * Ctrl+Enter copies a finding's recommended command without leaving.
 */
export function JumpDialog({
  rows,
  shelvesLoading,
  onOpen,
  onClose,
}: {
  rows: JumpRow[];
  shelvesLoading: boolean;
  onOpen: (target: JumpTarget) => void;
  onClose: () => void;
}): preact.JSX.Element {
  const [query, setQuery] = useState("");
  // The active row is held by its key, not its index: shelf rows arrive
  // after the dialog opens, and an index would then point at another row.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo<Array<{ group: string; entries: Shown[] }>>(() => {
    const ranked: Shown[] =
      query.trim().length === 0
        ? rows.map((row) => ({ row, positions: [] }))
        : rankRows(query, rows);
    return JUMP_GROUPS.map((group) => ({
      group,
      entries: ranked
        .filter((entry) => entry.row.group === group)
        .slice(0, GROUP_LIMIT),
    })).filter((section) => section.entries.length > 0);
  }, [rows, query]);
  const flat = shown.flatMap((section) => section.entries);
  const current =
    flat.find((entry) => entry.row.key === activeKey) ?? flat[0] ?? null;

  // The dialog is modal: focus moves in on open and returns to the opener on
  // close, as the diff dialog does.
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    inputRef.current?.focus();
    document.body.classList.add("has-dialog");
    return () => {
      document.body.classList.remove("has-dialog");
      opener?.focus();
    };
  }, []);

  useEffect(() => setActiveKey(null), [query]);

  const onKeyDown = async (event: KeyboardEvent): Promise<void> => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The input is the dialog's only Tab stop: the rows follow
      // aria-activedescendant and the scrim is not focusable. Tab stays here
      // so focus cannot reach the page behind the modal.
      event.preventDefault();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (flat.length === 0) return;
      const index = current === null ? 0 : flat.indexOf(current);
      const next = flat[(index + step + flat.length) % flat.length];
      setActiveKey(next?.row.key ?? null);
    } else if (event.key === "Enter" && current) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        if (current.row.command === null) return;
        const ok = await copyText(current.row.command);
        setCopied(ok ? current.row.command : null);
        return;
      }
      onOpen(current.row.target);
    }
  };

  return (
    <div class="dialog-layer jump-layer">
      <button
        type="button"
        class="dialog-scrim"
        aria-label="Close jump"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        class="dialog jump-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to an item or project"
      >
        <label class="jump-input">
          <Icon name="search" />
          <span class="visually-hidden">Jump to</span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="jump-results"
            aria-activedescendant={
              current ? `jump-${flat.indexOf(current)}` : undefined
            }
            placeholder="Jump to a finding, project, item, or shelf item"
            value={query}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => void onKeyDown(event)}
            autocomplete="off"
            spellcheck={false}
          />
          <kbd>Esc</kbd>
        </label>
        <div id="jump-results" class="jump-results" role="listbox">
          {flat.length === 0 ? (
            <p class="jump-empty">Nothing matches “{query}”.</p>
          ) : (
            shown.map((section) => (
              <div key={section.group} role="presentation">
                <p class="jump-group" role="presentation">
                  {section.group}
                </p>
                {section.entries.map((entry) => {
                  const index = flat.indexOf(entry);
                  const tone =
                    entry.row.group === "Findings" ? " tone-attention" : "";
                  return (
                    <div
                      key={entry.row.key}
                      id={`jump-${index}`}
                      role="option"
                      // Focus stays in the input; the listbox follows
                      // aria-activedescendant. -1 keeps rows out of Tab.
                      tabIndex={-1}
                      aria-selected={entry === current}
                      class={`jump-row${tone}`}
                      onMouseEnter={() => setActiveKey(entry.row.key)}
                      onClick={() => onOpen(entry.row.target)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onOpen(entry.row.target);
                      }}
                    >
                      <span class="jump-row-name">
                        <HighlightedRef
                          text={entry.row.ref}
                          positions={entry.positions}
                        />
                      </span>
                      <span class="jump-row-detail">{entry.row.detail}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {shelvesLoading ? <p class="jump-empty">Reading the shelf…</p> : null}
        </div>
        <p class="jump-foot" aria-live="polite">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Ctrl</kbd> <kbd>Enter</kbd> copy the recommended command
          </span>
          {copied ? <span class="tone-ok">Copied {copied}</span> : null}
        </p>
      </div>
    </div>
  );
}
