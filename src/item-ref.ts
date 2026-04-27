import type { Lock } from "./lock";
import { ITEM_KINDS, isItemKind, listMasterItems } from "./master";
import type { ItemKind, MasterItem } from "./master";
import { parseLockKey } from "./installed";
import type { ItemSource } from "./installed";

export interface ItemRef {
  kind?: ItemKind;
  name: string;
}

export function parseItemRef(input: string): ItemRef {
  const raw = input.trim();
  if (!raw) throw new Error("empty item ref");

  const parts = raw.split("/");
  if (parts.length === 1) {
    return { name: requireName(parts[0]!, input) };
  }
  if (parts.length === 2) {
    const [kind, name] = parts;
    if (!kind || !isItemKind(kind)) {
      throw new Error(
        `invalid item kind "${kind ?? ""}" in "${input}" (supported: ${ITEM_KINDS.join(", ")})`,
      );
    }
    return { kind, name: requireName(name!, input) };
  }
  if (parts[0] === "data" || parts[0] === "system") {
    throw new Error(
      `"${input}" looks like a lock key; use ${parts[1]}/${parts.slice(2).join("/")} instead`,
    );
  }
  throw new Error(`invalid item ref "${input}" (expected <name> or <kind>/<name>)`);
}

export function formatItemRef(ref: ItemRef): string {
  return ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
}

export async function findMasterItemByRef(
  dataRepo: string,
  ref: ItemRef,
): Promise<MasterItem | null> {
  const items = await listMasterItems(dataRepo, ref.kind);
  const matches = items.filter((i) => i.name === ref.name);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous item "${ref.name}": found ${matches.map((m) => `${m.kind}/${m.name}`).join(", ")}; use kind/name`,
    );
  }
  return matches[0] ?? null;
}

export function lockKeysForRef(lock: Lock, ref: ItemRef): string[] {
  return Object.keys(lock.items).filter((key) => {
    const parsed = parseLockKey(key);
    return (
      parsed.name === ref.name &&
      (ref.kind === undefined || parsed.kind === ref.kind)
    );
  });
}

export function lockKeyForRef(
  lock: Lock,
  ref: ItemRef,
  source?: ItemSource,
): string | null {
  const keys = lockKeysForRef(lock, ref).filter((key) => {
    if (!source) return true;
    return parseLockKey(key).source === source;
  });
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    throw new Error(
      `ambiguous item "${ref.name}": found ${keys
        .map((key) => {
          const parsed = parseLockKey(key);
          return `${parsed.kind}/${parsed.name}`;
        })
        .join(", ")}; use kind/name`,
    );
  }
  return keys[0] ?? null;
}

function requireName(name: string, input: string): string {
  if (!name) throw new Error(`invalid item ref "${input}" (missing name)`);
  if (name === "." || name === "..") {
    throw new Error(`invalid item name "${name}"`);
  }
  return name;
}
