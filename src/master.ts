import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { isIgnoredDotDirent } from "./dotfiles";
import { gitVisibleFilesUnderPath } from "./git";

export const ITEM_KINDS = [
  "skills",
  "settings",
  "mcp",
  "codex-config",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export type FragmentItemKind = Exclude<ItemKind, "skills">;

export const FRAGMENT_ITEM_KINDS = [
  "settings",
  "mcp",
  "codex-config",
] as const satisfies readonly FragmentItemKind[];

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

export function isFragmentItemKind(value: ItemKind): value is FragmentItemKind {
  return value !== "skills";
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
    const dir = masterListDir(dataRepo, k);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (!(await isInstallableDataItem(dataRepo, k, e.name))) continue;
      const repoRelPath = itemRepoRelPath(k, e.name);
      const abs = join(dataRepo, ...repoRelPath.split("/"));
      items.push({
        kind: k,
        name: e.name,
        path: abs,
        repoRelPath,
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

export async function shaOfItemFiles(
  itemPath: string,
  files: string[],
): Promise<string> {
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

export function itemRepoRelPath(kind: ItemKind, name: string): string {
  switch (kind) {
    case "skills":
      return `skills/${name}`;
    case "settings":
      return `settings/${name}`;
    case "mcp":
      return `mcp/${name}`;
    case "codex-config":
      return `codex/config/${name}`;
  }
}

export function allCanonicalItemRelPaths(
  kind: ItemKind,
  name: string,
): string[] {
  switch (kind) {
    case "skills":
      return [itemRepoRelPath(kind, name)];
    case "settings":
      return [`settings/${name}/settings.json`];
    case "mcp":
      return [`mcp/${name}/claude.json`, `mcp/${name}/codex.toml`];
    case "codex-config":
      return [`codex/config/${name}/config.toml`];
  }
}

export async function canonicalItemRelPaths(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string[]> {
  if (kind === "skills") return [itemRepoRelPath(kind, name)];
  const paths = allCanonicalItemRelPaths(kind, name).filter((relPath) =>
    existsSync(join(dataRepo, ...relPath.split("/"))),
  );
  if (paths.length === 0) {
    throw new Error(
      `data repo does not have canonical source files for ${kind}/${name}`,
    );
  }
  return paths;
}

function masterListDir(dataRepo: string, kind: ItemKind): string {
  if (kind === "codex-config") return join(dataRepo, "codex", "config");
  return join(dataRepo, kind);
}

async function isInstallableDataItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<boolean> {
  if (kind === "skills") return true;
  return allCanonicalItemRelPaths(kind, name).some((relPath) =>
    existsSync(join(dataRepo, ...relPath.split("/"))),
  );
}
