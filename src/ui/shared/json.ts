/**
 * The JSON value model for the browser bundle. `src/config-values.ts` owns
 * the same model for the CLI, but it imports zod, which the client must not
 * carry, so the two predicates the client needs live here.
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

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
