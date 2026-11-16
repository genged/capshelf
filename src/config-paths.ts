/**
 * Rows show a shape summary, never a scalar value, because config values can be
 * credentials and the picker paints into a live frame.
 */
import { isTerminalControlCode } from "./assert";
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";

export interface ConfigPathRow {
  /**
   * Dot-joined `--pick` path; pickable keys never contain a dot, so splitting
   * on `.` recovers the segments.
   */
  path: string;
  detail: string;
  value: ConfigValue;
}

export function configDetailLabel(value: ConfigValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return countLabel(value.length, "entry", "entries");
  if (isConfigObject(value)) {
    return countLabel(Object.keys(value).length, "key", "keys");
  }
  if (value === true || value === false) return "boolean";
  return isConfigString(value) ? "string" : "number";
}

/**
 * Keys with a literal dot, empty keys, or terminal control characters are
 * skipped with their subtree: pick paths split on `.`, and `shellArg` preserves
 * bytes, so a raw ESC from untrusted project files would reach the terminal.
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
    if (isConfigObject(child)) walk(child, segments, rows);
  }
}

/**
 * A nested unpickable key is covered by its ancestor's row, but a top-level one
 * has none, so the share catalog shows it as a disabled row instead of an
 * empty-looking output.
 */
export function isPickableKey(key: string): boolean {
  if (key.length === 0 || key.includes(".")) return false;
  for (const char of key) {
    if (isTerminalControlCode(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Parent and child both marked would pass a redundant `--pick` flag, since
 * extracting the parent already carries the child.
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
