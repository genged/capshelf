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

export function mergeConfigObjects(fragments: ConfigObject[]): ConfigObject {
  let merged: ConfigObject = {};
  for (const fragment of fragments) {
    merged = mergeConfigValues(merged, fragment) as ConfigObject;
  }
  return merged;
}

export function mergeConfigValues(
  base: ConfigValue | undefined,
  overlay: ConfigValue,
): ConfigValue {
  if (Array.isArray(base) && Array.isArray(overlay)) {
    return dedupeArray([...base, ...overlay]);
  }
  if (isPlainConfigObject(base) && isPlainConfigObject(overlay)) {
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

  if (isPlainConfigObject(current) && isPlainConfigObject(managed)) {
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

  if (isPlainConfigObject(managed)) {
    if (!isPlainConfigObject(current)) return false;
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
  if (isPlainConfigObject(localBase) && isPlainConfigObject(managed)) {
    for (const key of Object.keys(managed)) {
      const collision = findUnmanagedCollision(
        Object.hasOwn(localBase, key) ? localBase[key] : undefined,
        managed[key] as ConfigValue,
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

export function stableSortConfig(
  value: ConfigValue | undefined,
): ConfigValue | undefined {
  if (Array.isArray(value)) return value.map(stableSortConfig) as ConfigValue[];
  if (!isPlainConfigObject(value)) return value;

  const out: ConfigObject = {};
  for (const key of Object.keys(value).sort()) {
    defineConfigProperty(out, key, stableSortConfig(value[key]) as ConfigValue);
  }
  return out;
}

export function shaOfConfig(value: ConfigValue): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableStringifyConfig(value));
  return hasher.digest("hex").slice(0, 12);
}

export function cloneConfig<T extends ConfigValue | undefined>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneConfig(entry)) as T;
  }
  if (isPlainConfigObject(value)) {
    return cloneConfigObject(value) as T;
  }
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

export function isPlainConfigObject(value: unknown): value is ConfigObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function configPathLabel(path: string[]): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

export function configValueKind(value: ConfigValue | undefined): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isPlainConfigObject(value)) return "object";
  return typeof value;
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
