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
 * The default YAML 1.2 core schema yields only JSON-model values; timestamps
 * and binary stay strings.
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

export function yamlParseDetail(cause: unknown): string {
  return cause instanceof YAMLParseError && cause.linePos?.[0]
    ? `line ${cause.linePos[0].line}: ${firstLine(cause.message)}`
    : firstLine(cause instanceof Error ? cause.message : String(cause));
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

/**
 * Edit through the document model, not appended text, because an item's sidecar
 * belongs to its author and adopt only adds fields to it.
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
