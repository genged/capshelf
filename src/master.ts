import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { isIgnoredDotDirent } from "./dotfiles";
import { gitVisibleFilesUnderPath } from "./git";

export const ITEM_KINDS = ["skills", "settings", "mcp"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(value: string): value is ItemKind {
  return ITEM_KINDS.includes(value as ItemKind);
}

export interface MasterItem {
  kind: ItemKind;
  name: string;
  /** absolute path on disk */
  path: string;
  /** path relative to the data repo root, used for git operations */
  repoRelPath: string;
}

export function assertDataRepoExists(dataRepo: string): string {
  if (!existsSync(dataRepo)) {
    throw new Error(
      `data repo not found at ${dataRepo}\n  pass --data <path>, set $CAPSHELF_HOME, or place a data repo at ~/code/capshelf-data`,
    );
  }
  return dataRepo;
}

export async function listMasterItems(
  dataRepo: string,
  kind?: ItemKind,
): Promise<MasterItem[]> {
  assertDataRepoExists(dataRepo);
  const kinds: readonly ItemKind[] = kind ? [kind] : ITEM_KINDS;
  const items: MasterItem[] = [];
  for (const k of kinds) {
    const dir = join(dataRepo, k);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      items.push({
        kind: k,
        name: e.name,
        path: abs,
        repoRelPath: relative(dataRepo, abs),
      });
    }
  }
  return items;
}

export async function findMasterItem(
  dataRepo: string,
  name: string,
): Promise<MasterItem | null> {
  const all = await listMasterItems(dataRepo);
  const matches = all.filter((i) => i.name === name);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous name "${name}": found in ${matches.map((m) => m.kind).join(", ")}`,
    );
  }
  return matches[0] ?? null;
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function go(rel: string): Promise<void> {
    const abs = rel ? join(root, rel) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (isIgnoredDotDirent(e)) continue;
      const childRel = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) await go(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  }
  await go("");
  out.sort();
  return out;
}

/**
 * Hash an item's content. Works on both directories (skills, settings,
 * mcp fragments) and single files (future codex agents).
 */
export async function shaOfItem(itemPath: string): Promise<string> {
  const info = await stat(itemPath);
  if (info.isFile()) {
    return shaOfItemFiles(itemPath, []);
  }
  return shaOfItemFiles(itemPath, await walkFiles(itemPath));
}

export async function shaOfGitVisibleItem(
  repo: string,
  relPath: string,
): Promise<string> {
  return shaOfItemFiles(
    join(repo, ...relPath.split("/")),
    await gitVisibleFilesUnderPath(repo, relPath),
  );
}

async function shaOfItemFiles(itemPath: string, files: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const info = await stat(itemPath);
  if (info.isFile()) {
    hasher.update(basename(itemPath));
    hasher.update("\0");
    hasher.update(await readFile(itemPath));
    hasher.update("\0");
  } else {
    for (const rel of files) {
      hasher.update(rel);
      hasher.update("\0");
      hasher.update(await readFile(join(itemPath, ...rel.split("/"))));
      hasher.update("\0");
    }
  }
  return hasher.digest("hex").slice(0, 12);
}
