/**
 * Walk a config object into the dot paths `--pick` accepts, each with a shape
 * summary for the picker's detail column.
 *
 * Pure, like `pick-core.ts`: no filesystem and no terminal, so the walk, the
 * labels, and the ancestor dedupe are unit tests.
 *
 * The shape summary is deliberate: a row never shows a scalar value, because a
 * config value can be a credential and the picker paints into a live frame.
 * `2 keys` and `string` identify a row; the path does the rest.
 */
import { isTerminalControlCode } from "./assert";
import { isPlainConfigObject } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";

export interface ConfigPathRow {
  /**
   * Dot-joined path — the exact string `--pick` takes. Pickable keys cannot
   * contain a dot, so `path.split(".")` recovers the segments exactly.
   */
  path: string;
  /** Detail summary, never the value: `2 keys`, `3 entries`, `string`. */
  detail: string;
  /** The node itself, so a caller can fingerprint what the row named. */
  value: ConfigValue;
}

/** The detail text for one value: its structure, never its content. */
export function configDetailLabel(value: ConfigValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return countLabel(value.length, "entry", "entries");
  if (isPlainConfigObject(value)) {
    return countLabel(Object.keys(value).length, "key", "keys");
  }
  return typeof value;
}

/**
 * Every node of `value` as a pick path, parents before children, in document
 * order. The root itself gets no row: `--pick` takes a path into the object,
 * and the whole object is not a path.
 *
 * A key that `--pick` cannot name is skipped with its subtree. Pick paths
 * split on `.` (`pickPathSegments`), so a key containing a literal dot, or an
 * empty key, has no pick syntax at all. Its nearest offerable ancestor still
 * covers it.
 *
 * A key holding a terminal control character is skipped for a different
 * reason: the path becomes a row label, a `--pick` argument in a printed
 * equivalent command, and a retry command. `shellArg` quotes for the shell but
 * deliberately preserves bytes, so a raw ESC in a printed command would reach
 * the live terminal. These keys come from files a cloned project's tools
 * wrote, which is untrusted input.
 */
export function walkConfigPaths(value: ConfigObject): ConfigPathRow[] {
  const rows: ConfigPathRow[] = [];
  walk(value, [], rows);
  return rows;
}

function walk(
  value: ConfigObject,
  prefix: string[],
  rows: ConfigPathRow[],
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!isPickableKey(key)) continue;
    const segments = [...prefix, key];
    rows.push({
      path: segments.join("."),
      detail: configDetailLabel(child),
      value: child,
    });
    if (isPlainConfigObject(child)) walk(child, segments, rows);
  }
}

/**
 * Whether `--pick` can name and safely print a key: non-empty, no literal dot
 * (pick paths split on dots), no control character (C0, DEL, C1 — the set
 * `sanitizeDisplayText` blanks). A nested unpickable key is covered by its
 * ancestor's row; a top-level one has no ancestor, so the share catalog shows
 * it as a disabled row rather than letting the output read as empty.
 */
export function isPickableKey(key: string): boolean {
  if (key.length === 0 || key.includes(".")) return false;
  for (const char of key) {
    if (isTerminalControlCode(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Drop every marked path whose strict ancestor is also marked.
 *
 * Marking `permissions` and `permissions.allow` names the same fragment twice:
 * extracting the parent already carries the child. Passing both to `--pick`
 * would merge the child into the parent's copy and change nothing, so the
 * printed equivalent command would carry a redundant flag.
 */
export function dedupeAncestorPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => {
    const segments = path.split(".");
    return !unique.some((other) => {
      if (other === path) return false;
      const otherSegments = other.split(".");
      return (
        otherSegments.length < segments.length &&
        otherSegments.every((segment, index) => segments[index] === segment)
      );
    });
  });
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
