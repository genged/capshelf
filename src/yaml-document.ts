import {
  Document,
  YAMLParseError,
  parseDocument,
  parse as parseYaml,
} from "yaml";
import type { ConfigValue } from "./config-values";

export type ParsedYaml =
  | { ok: true; value: ConfigValue | undefined }
  | { ok: false; warnings: string[] };

/**
 * Parse one YAML document into the JSON value model. The default `yaml`
 * schema (YAML 1.2 core) emits only null, booleans, numbers, strings,
 * arrays, and plain objects. Timestamps and binary stay strings.
 */
export function parseYamlDocument(
  text: string,
  itemLabel: string,
  sourceLabel: string,
): ParsedYaml {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch (cause) {
    return {
      ok: false,
      warnings: [
        `${itemLabel}: invalid ${sourceLabel} (${yamlParseDetail(cause)}) — metadata ignored`,
      ],
    };
  }
}

/** The one-line reason a YAML parse failed, with the line when known. */
export function yamlParseDetail(cause: unknown): string {
  return cause instanceof YAMLParseError && cause.linePos?.[0]
    ? `line ${cause.linePos[0].line}: ${firstLine(cause.message)}`
    : firstLine(cause instanceof Error ? cause.message : String(cause));
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/**
 * Set or delete top-level scalar fields in a YAML document, keeping every other
 * field and the document's comments.
 *
 * Through the document model rather than by appending text: an item's sidecar
 * belongs to whoever wrote it, and an adopt adds three fields to it rather than
 * replacing it. A `null` value deletes the field.
 */
export function setYamlFields(
  text: string,
  fields: ReadonlyArray<readonly [string, string | null]>,
): string {
  const doc = text.trim().length > 0 ? parseDocument(text) : new Document({});
  for (const [key, value] of fields) {
    if (value === null) doc.delete(key);
    else doc.set(key, value);
  }
  return doc.toString();
}
