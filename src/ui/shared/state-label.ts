/**
 * Short labels for the fourteen status states, for the web UI's panel
 * headers. The CLI's own sentence (`describe` in `src/status-format.ts`)
 * travels beside them as `stateDetail`; this file only shortens, it never
 * reinterprets.
 */
import type { State } from "../../status-core";
import type { StateTone } from "./api-types";

export type StateIconName =
  | "check"
  | "alert"
  | "pencil"
  | "question"
  | "bang"
  | "notequal";

export function stateLabel(state: State, source: "data" | "system"): string {
  switch (state) {
    case "ok":
      return "Up to date";
    case "update_available":
      return "Update available";
    case "drifted_local":
      return "Drifted";
    case "drifted_and_update":
      return "Drifted, update available";
    case "missing_installed":
      return "Not installed";
    case "missing_output":
      return "Output missing";
    case "output_drift":
      return "Output drifted";
    case "missing_upstream":
      return source === "system" ? "Gone from this CLI" : "Gone from the shelf";
    case "upstream_dirty":
      return "Shelf edit uncommitted";
    case "source_dirty":
      return "Shelf source uncommitted";
    case "drifted_and_upstream_dirty":
      return "Drifted, shelf edit uncommitted";
    case "source_dirty_and_output_drift":
      return "Output drifted, shelf source uncommitted";
    case "missing_source_commit":
      return "Pinned commit unreachable";
    case "source_filtered":
      return "Source uses a git filter";
    case "kept-local":
      return "Kept local";
  }
}

export function stateTone(state: State): StateTone {
  if (state === "ok") return "ok";
  if (state === "kept-local") return "kept";
  return "attention";
}

/** The icon that stands in for the CLI glyph (`glyph` in status-format). */
export function stateIcon(state: State): StateIconName {
  switch (state) {
    case "ok":
      return "check";
    case "update_available":
      return "alert";
    case "drifted_local":
    case "drifted_and_update":
    case "output_drift":
    case "drifted_and_upstream_dirty":
    case "source_dirty_and_output_drift":
      return "pencil";
    case "missing_installed":
    case "missing_output":
      return "question";
    case "missing_source_commit":
    case "source_filtered":
    case "missing_upstream":
    case "upstream_dirty":
    case "source_dirty":
      return "bang";
    case "kept-local":
      return "notequal";
  }
}
