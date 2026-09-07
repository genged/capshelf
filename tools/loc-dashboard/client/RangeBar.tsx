/**
 * The one filter row. Presets first, then the custom range, then a caption
 * that says what the selection resolved to. Everything below the row shows
 * the same slice.
 */
import type { JSX } from "preact";
import {
  type Range,
  type RangeSelection,
  PRESETS,
  formatDate,
  formatInt,
  normalizeCustom,
  sameSelection,
  toDay,
} from "../shared/series";

export function RangeBar({
  selection,
  range,
  commits,
  days,
  onSelect,
}: {
  selection: RangeSelection;
  range: Range;
  commits: number;
  days: number;
  onSelect: (selection: RangeSelection) => void;
}): JSX.Element {
  const from =
    selection.kind === "custom" ? selection.from : toDay(range.start);
  const to = selection.kind === "custom" ? selection.to : toDay(range.end - 1);
  const custom = (nextFrom: string, nextTo: string): void => {
    if (nextFrom.length === 0 || nextTo.length === 0) return;
    onSelect(normalizeCustom(nextFrom, nextTo));
  };
  return (
    <fieldset class="filters">
      <legend class="visually-hidden">Range</legend>
      <nav class="view-nav" aria-label="Preset range">
        {PRESETS.map((preset) => {
          const active = sameSelection(preset.selection, selection);
          return (
            <button
              key={preset.label}
              type="button"
              class={`view-tab${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => onSelect(preset.selection)}
            >
              {preset.label}
            </button>
          );
        })}
      </nav>
      <div
        class={`range-custom${selection.kind === "custom" ? " is-active" : ""}`}
      >
        <label class="range-field">
          <span class="visually-hidden">From</span>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(event) => custom(event.currentTarget.value, to)}
          />
        </label>
        <span class="range-to" aria-hidden="true">
          to
        </span>
        <label class="range-field">
          <span class="visually-hidden">To</span>
          <input
            type="date"
            value={to}
            min={from}
            onChange={(event) => custom(from, event.currentTarget.value)}
          />
        </label>
      </div>
      <p class="range-caption" aria-live="polite">
        {formatDate(range.start)} – {formatDate(range.end - 1)}
        <span class="range-caption-sep" aria-hidden="true">
          {" · "}
        </span>
        {formatInt(commits)} {commits === 1 ? "commit" : "commits"}
        <span class="range-caption-sep" aria-hidden="true">
          {" · "}
        </span>
        {days} {days === 1 ? "day" : "days"}
      </p>
    </fieldset>
  );
}
