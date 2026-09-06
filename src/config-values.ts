import { z } from "zod";

export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | ConfigObject;

export interface ConfigObject {
  [key: string]: ConfigValue;
}

/** The JSON value model as a zod schema, for documents zod validates. */
export const ConfigValueSchema: z.ZodType<ConfigValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(ConfigValueSchema),
    z.record(z.string(), ConfigValueSchema),
  ]),
);

export function mergeConfigObjects(fragments: ConfigObject[]): ConfigObject {
  let merged: ConfigObject = {};
  for (const fragment of fragments) {
    merged = mergeConfigObject(merged, fragment);
  }
  return merged;
}

export function mergeConfigObject(
  base: ConfigObject,
  overlay: ConfigObject,
): ConfigObject {
  const out = cloneConfigObject(base);
  for (const [key, value] of Object.entries(overlay)) {
    defineConfigProperty(
      out,
      key,
      Object.hasOwn(out, key)
        ? mergeConfigValues(out[key], value)
        : cloneConfig(value),
    );
  }
  return out;
}

export function mergeConfigValues(
  base: ConfigValue | undefined,
  overlay: ConfigValue,
): ConfigValue {
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return dedupeArray([...base, ...overlay]);
  }
  if (isConfigObject(base) && isConfigObject(overlay)) {
    return mergeConfigObject(base, overlay);
  }
  return cloneConfig(overlay);
}

export function removeManagedValue(
  current: ConfigValue | undefined,
  managed: ConfigValue | undefined,
): ConfigValue | undefined {
  if (managed === undefined) return cloneConfig(current);
  if (current === undefined) return undefined;

  if (Array.isArray(current) && Array.isArray(managed)) {
    const managedKeys = new Set(managed.map(stableStringifyConfig));
    const kept = current.filter(
      (value) => !managedKeys.has(stableStringifyConfig(value)),
    );
    return kept.length > 0 ? kept : undefined;
  }

  if (isConfigObject(current) && isConfigObject(managed)) {
    const out = cloneConfigObject(current);
    for (const key of Object.keys(managed)) {
      if (!Object.hasOwn(out, key)) continue;
      const next = removeManagedValue(out[key], managed[key]);
      if (next === undefined) delete out[key];
      else defineConfigProperty(out, key, next);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  return undefined;
}

export function containsManagedValue(
  current: ConfigValue | undefined,
  managed: ConfigValue,
): boolean {
  if (Array.isArray(managed)) {
    if (!Array.isArray(current)) return false;
    const currentKeys = new Set(current.map(stableStringifyConfig));
    return managed.every((value) =>
      currentKeys.has(stableStringifyConfig(value)),
    );
  }

  if (isConfigObject(managed)) {
    if (!isConfigObject(current)) return false;
    return Object.entries(managed).every(
      ([key, value]) =>
        Object.hasOwn(current, key) &&
        containsManagedValue(current[key], value),
    );
  }

  return stableStringifyConfig(current) === stableStringifyConfig(managed);
}

export interface ConfigCollision {
  path: string[];
  localKind: string;
  managedKind: string;
}

export function findUnmanagedCollision(
  localBase: ConfigValue | undefined,
  managed: ConfigValue,
  path: string[] = [],
): ConfigCollision | null {
  if (localBase === undefined) return null;
  if (stableStringifyConfig(localBase) === stableStringifyConfig(managed)) {
    return null;
  }
  if (Array.isArray(localBase) && Array.isArray(managed)) return null;
  if (isConfigObject(localBase) && isConfigObject(managed)) {
    for (const [key, value] of Object.entries(managed)) {
      const collision = findUnmanagedCollision(
        Object.hasOwn(localBase, key) ? localBase[key] : undefined,
        value,
        [...path, key],
      );
      if (collision) return collision;
    }
    return null;
  }
  return {
    path,
    localKind: configValueKind(localBase),
    managedKind: configValueKind(managed),
  };
}

export function stableStringifyConfig(value: ConfigValue | undefined): string {
  return JSON.stringify(stableSortConfig(value));
}

export function stableSortConfig(value: ConfigObject): ConfigObject;
export function stableSortConfig(value: ConfigValue): ConfigValue;
export function stableSortConfig(
  value: ConfigValue | undefined,
): ConfigValue | undefined;
export function stableSortConfig(
  value: ConfigValue | undefined,
): ConfigValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value))
    return value.map((entry) => stableSortConfig(entry));
  if (!isConfigObject(value)) return value;

  const out: ConfigObject = {};
  // UTF-16 code-unit order, the same order the default `sort()` used.
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, child] of entries) {
    defineConfigProperty(out, key, stableSortConfig(child));
  }
  return out;
}

export function shaOfConfig(value: ConfigValue): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableStringifyConfig(value));
  return hasher.digest("hex").slice(0, 12);
}

export function cloneConfig(value: ConfigObject): ConfigObject;
export function cloneConfig(value: ConfigValue): ConfigValue;
export function cloneConfig(
  value: ConfigValue | undefined,
): ConfigValue | undefined;
export function cloneConfig(
  value: ConfigValue | undefined,
): ConfigValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry) => cloneConfig(entry));
  if (isConfigObject(value)) return cloneConfigObject(value);
  return value;
}

export function defineConfigProperty(
  target: ConfigObject,
  key: string,
  value: ConfigValue,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * The boundary predicate: whether a value of unknown origin is a plain object
 * (`Object.prototype` or a null prototype). Class instances, `Map`s, and
 * `Date`s are not config objects even though they are objects.
 */
export function isPlainConfigObject(value: unknown): value is ConfigObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The object member of `ConfigValue`, for values already parsed. The body
 * repeats the boundary predicate on purpose: a shared helper would take the
 * broad `object` type, and a call into the `unknown` predicate would widen.
 */
export function isConfigObject(
  value: ConfigValue | undefined,
): value is ConfigObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isConfigString(
  value: ConfigValue | undefined,
): value is string {
  return typeof value === "string";
}

export function isConfigNumber(
  value: ConfigValue | undefined,
): value is number {
  return typeof value === "number";
}

export function configPathLabel(path: string[]): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

export function configValueKind(value: ConfigValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isConfigObject(value)) return "object";
  if (value === true || value === false) return "boolean";
  return isConfigString(value) ? "string" : "number";
}

function dedupeArray(values: ConfigValue[]): ConfigValue[] {
  const seen = new Set<string>();
  const out: ConfigValue[] = [];
  for (const value of values) {
    const key = stableStringifyConfig(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cloneConfig(value));
  }
  return out;
}

function cloneConfigObject(value: ConfigObject): ConfigObject {
  const out: ConfigObject = {};
  for (const [key, child] of Object.entries(value)) {
    defineConfigProperty(out, key, cloneConfig(child));
  }
  return out;
}
