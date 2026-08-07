import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { atomicWriteFile } from "./fs-utils";
import { dirname, join } from "node:path";
import { inventoryLocalTree } from "./gitignore";
import bootstrap from "./bundled/skills/capshelf/SKILL.md" with {
  type: "text",
};
import pkg from "../package.json" with { type: "json" };
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  installedPath,
} from "./installed";
import type { InstallMode } from "./paths";
import type { MaterializedItemKind } from "./master";
import { SYSTEM_SKILL_NAME } from "./identity";

export const CLI_VERSION = (pkg as { version: string }).version;

export interface BundledFile {
  relPath: string;
  content: string;
}

export interface SystemItem {
  kind: MaterializedItemKind;
  name: string;
  files: BundledFile[];
}

export const SYSTEM_ITEMS: readonly SystemItem[] = [
  {
    kind: "skills",
    name: SYSTEM_SKILL_NAME,
    files: [{ relPath: "SKILL.md", content: bootstrap }],
  },
];

export function findSystemItem(name: string): SystemItem | null {
  return SYSTEM_ITEMS.find((i) => i.name === name) ?? null;
}

export function isSystemItemName(name: string): boolean {
  return SYSTEM_ITEMS.some((i) => i.name === name);
}

export function systemTargetDir(
  project: string,
  item: SystemItem,
  mode?: InstallMode,
): string {
  return installedPath(project, item.kind, item.name, mode);
}

/**
 * Hash a system item the same way as a data item so drift detection
 * compares apples to apples (see master.ts shaOfItem).
 */
export async function shaOfSystemItem(item: SystemItem): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const sorted = [...item.files].sort((a, b) =>
    a.relPath.localeCompare(b.relPath),
  );
  for (const f of sorted) {
    hasher.update(f.relPath);
    hasher.update("\0");
    hasher.update(f.content);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}

/**
 * True when the install target already holds exactly this bundled item.
 *
 * An `init` interrupted after the system items were written but before the
 * lock was saved leaves such a directory behind with no lock entry. Without
 * this check the re-run — which is the documented recovery — would refuse its
 * own leftovers as an unmanaged target and the project would be stuck.
 */
export async function installedMatchesSystemItem(
  project: string,
  item: SystemItem,
  mode?: InstallMode,
): Promise<boolean> {
  const dst = systemTargetDir(project, item, mode);
  if (!existsSync(dst)) return false;
  const inventory = await inventoryLocalTree(dst).catch(() => null);
  if (inventory === null || inventory.irregular.length > 0) return false;
  const expected = new Map(item.files.map((f) => [f.relPath, f.content]));
  if (inventory.files.length !== expected.size) return false;
  for (const relPath of inventory.files) {
    const content = expected.get(relPath);
    if (content === undefined) return false;
    const onDisk = await readFile(join(dst, ...relPath.split("/")), "utf-8");
    if (onDisk !== content) return false;
  }
  return true;
}

export async function installSystemItem(
  project: string,
  item: SystemItem,
  mode?: InstallMode,
): Promise<string> {
  const dst = systemTargetDir(project, item, mode);
  assertCanMaterializeInstalled(project, item.kind, item.name, mode);
  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });
  for (const f of item.files) {
    const filePath = join(dst, f.relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, f.content);
  }
  await ensureInstallAliases(project, item.kind, item.name, mode);
  return dst;
}
