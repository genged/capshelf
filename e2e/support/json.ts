/**
 * The JSON value model for observations. The end-to-end layer imports
 * nothing from `src/`, so it owns this small copy of the model that
 * `src/config-values.ts` defines for the CLI.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/** `JSON.parse` without a reviver yields exactly the members of `JsonValue`. */
export function parseJsonText(text: string, label: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${label} is not JSON: ${detail}\n${text}`);
  }
}

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asObject(
  value: JsonValue | undefined,
  label: string,
): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} is not an object: ${JSON.stringify(value)}`);
  }
  return value;
}

export function asArray(
  value: JsonValue | undefined,
  label: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array: ${JSON.stringify(value)}`);
  }
  return value;
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function asString(value: JsonValue | undefined, label: string): string {
  if (!isJsonString(value)) {
    throw new Error(`${label} is not a string: ${JSON.stringify(value)}`);
  }
  return value;
}

/** A field that must be present. `undefined` is absence; `null` is a value. */
export function objectField(
  object: JsonObject,
  key: string,
  label: string,
): JsonValue {
  const value = object[key];
  if (value === undefined) {
    throw new Error(`${label} has no "${key}": ${JSON.stringify(object)}`);
  }
  return value;
}
