/**
 * One stroke, one weight. The state icons stand in for the CLI glyphs, and
 * every one of them sits beside a word.
 */
import type { StateIconName } from "../shared/state-label";

export type IconName =
  | StateIconName
  | "copy"
  | "refresh"
  | "chevron"
  | "folder"
  | "search"
  | "menu"
  | "close"
  | "keyboard"
  | "shelf"
  | "arrow"
  | "expand";

const PATHS: Record<IconName, string> = {
  check: "M3.5 8.5l3 3 6-7",
  alert: "M8 2.5l6 10.5H2L8 2.5zM8 7v3M8 12.2v.1",
  pencil:
    "M3 13l.8-3.2L11 2.6a1.2 1.2 0 011.7 0l.7.7a1.2 1.2 0 010 1.7L6.2 12.2 3 13zM9.8 3.8l2.4 2.4",
  question: "M5.8 6a2.2 2.2 0 114 1.2c-.8.8-1.8 1-1.8 2.3M8 12.2v.1",
  bang: "M8 3v6M8 12.2v.1",
  notequal: "M3 6.2h10M3 9.8h10M10.5 3l-5 10",
  copy: "M6 6h7v7H6zM3 10V3h7",
  refresh: "M13 8a5 5 0 01-9 3M3 8a5 5 0 019-3M12 2v3H9M4 14v-3h3",
  chevron: "M6 3.5L10.5 8 6 12.5",
  folder:
    "M2 4.5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1v-7.5z",
  search: "M7 11.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9zM10.3 10.3L14 14",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  close: "M4 4l8 8M12 4l-8 8",
  keyboard: "M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M4.5 9.5h7",
  shelf: "M2 5h12M2 8.5h12M2 12h12M4 3v2M4 6.5v2M4 10v2",
  arrow: "M3 8h10M9 4l4 4-4 4",
  expand: "M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9",
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

/**
 * With a `label` the icon is an image with that name; without one it is
 * decoration beside text and hidden from assistive technology.
 */
export function Icon({
  name,
  label,
}: {
  name: IconName;
  label?: string;
}): preact.JSX.Element {
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
