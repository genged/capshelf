/**
 * The capshelf icon set, one stroke and one weight, reduced to the names
 * this dashboard uses. Every icon sits beside a word or carries a label.
 */
import type { JSX } from "preact";

export type IconName =
  | "check"
  | "alert"
  | "bang"
  | "refresh"
  | "close"
  | "chevron"
  | "arrow";

const PATHS: Record<IconName, string> = {
  check: "M3.5 8.5l3 3 6-7",
  alert: "M8 2.5l6 10.5H2L8 2.5zM8 7v3M8 12.2v.1",
  bang: "M8 3v6M8 12.2v.1",
  refresh: "M13 8a5 5 0 01-9 3M3 8a5 5 0 019-3M12 2v3H9M4 14v-3h3",
  close: "M4 4l8 8M12 4l-8 8",
  chevron: "M6 3.5L10.5 8 6 12.5",
  arrow: "M3 8h10M9 4l4 4-4 4",
};

const STROKE = {
  viewBox: "0 0 16 16",
  width: "16",
  height: "16",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.6",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

export function Icon({
  name,
  label,
}: {
  name: IconName;
  label?: string;
}): JSX.Element {
  if (label !== undefined) {
    return (
      <svg
        class={`icon icon-${name}`}
        role="img"
        aria-label={label}
        {...STROKE}
      >
        <title>{label}</title>
        <path d={PATHS[name]} />
      </svg>
    );
  }
  return (
    <svg class={`icon icon-${name}`} aria-hidden="true" {...STROKE}>
      <path d={PATHS[name]} />
    </svg>
  );
}
