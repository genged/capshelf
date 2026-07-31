import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { hashNamedContents } from "./content-hash";
import { assertNever } from "./assert";
import { isIgnoredDotDirent } from "./dotfiles";
import { gitVisibleFilesUnderPath } from "./git";
import { METADATA_SIDECAR } from "./identity";

export const ITEM_KINDS = [
  "skills",
  "pi-extensions",
  "subagents",
  "settings",
  "mcp",
  "codex-config",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const COPY_DIRECTORY_ITEM_KINDS = ["skills", "pi-extensions"] as const;
export type CopyDirectoryItemKind = (typeof COPY_DIRECTORY_ITEM_KINDS)[number];

export const COPY_TARGET_FILE_ITEM_KINDS = ["subagents"] as const;
export type CopyTargetFileItemKind =
  (typeof COPY_TARGET_FILE_ITEM_KINDS)[number];

export const FRAGMENT_ITEM_KINDS = ["settings", "mcp", "codex-config"] as const;
export type FragmentItemKind = (typeof FRAGMENT_ITEM_KINDS)[number];

export type MaterializedItemKind =
  | CopyDirectoryItemKind
  | CopyTargetFileItemKind;

export type ItemStrategy = "copy-directory" | "copy-target-file" | "fragment";

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

export function isCopyDirectoryItemKind(
  value: ItemKind,
): value is CopyDirectoryItemKind {
  return (COPY_DIRECTORY_ITEM_KINDS as readonly ItemKind[]).includes(value);
}

export function isCopyTargetFileItemKind(
  value: ItemKind,
): value is CopyTargetFileItemKind {
  return (COPY_TARGET_FILE_ITEM_KINDS as readonly ItemKind[]).includes(value);
}

export function isFragmentItemKind(value: ItemKind): value is FragmentItemKind {
  return (FRAGMENT_ITEM_KINDS as readonly ItemKind[]).includes(value);
}

export function isMaterializedItemKind(
  value: ItemKind,
): value is MaterializedItemKind {
  return isCopyDirectoryItemKind(value) || isCopyTargetFileItemKind(value);
}

export function itemStrategy(kind: ItemKind): ItemStrategy {
  switch (kind) {
    case "skills":
    case "pi-extensions":
      return "copy-directory";
    case "subagents":
      return "copy-target-file";
    case "settings":
    case "mcp":
    case "codex-config":
      return "fragment";
    default:
      return assertNever(kind);
  }
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

/**
 * True when an item-root-relative path is the item's metadata sidecar.
 * `rel` must be relative to the item root: the check is exactly
 * `rel === ".capshelf.yml"`, never a basename match — nested
 * `sub/.capshelf.yml` files are item content and stay hashed/materialized.
 * The sidecar is catalog data only; it is excluded from every hashing path
 * and from materialization so metadata edits never look like content drift.
 */
export function isMetadataSidecarPath(rel: string): boolean {
  return rel === METADATA_SIDECAR;
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
 * Hash an item's content. Works on both directories (copy items and fragment
 * roots) and single files (future codex agents).
 */
export async function shaOfItem(itemPath: string): Promise<string> {
  const info = await stat(itemPath);
  if (info.isFile()) {
    return shaOfItemFiles(itemPath, []);
  }
  return shaOfItemFiles(
    itemPath,
    (await walkFiles(itemPath)).filter((rel) => !isMetadataSidecarPath(rel)),
  );
}

export async function shaOfGitVisibleItem(
  repo: string,
  relPath: string,
): Promise<string> {
  return shaOfItemFiles(
    join(repo, ...relPath.split("/")),
    (await gitVisibleFilesUnderPath(repo, relPath)).filter(
      (rel) => !isMetadataSidecarPath(rel),
    ),
  );
}

export async function shaOfItemFiles(
  itemPath: string,
  files: string[],
): Promise<string> {
  const info = await stat(itemPath);
  const named = info.isFile()
    ? [{ name: basename(itemPath), path: itemPath }]
    : files.map((rel) => ({
        name: rel,
        path: join(itemPath, ...rel.split("/")),
      }));
  return hashNamedContents(
    await Promise.all(
      named.map(async ({ name, path }) => ({
        name,
        content: await readFile(path),
      })),
    ),
  );
}

export function itemRepoRelPath(kind: ItemKind, name: string): string {
  switch (kind) {
    case "skills":
      return `skills/${name}`;
    case "pi-extensions":
      return `pi/extensions/${name}`;
    case "settings":
      return `settings/${name}`;
    case "mcp":
      return `mcp/${name}`;
    case "codex-config":
      return `codex/config/${name}`;
    case "subagents":
      return `subagents/${name}`;
    default:
      return assertNever(kind);
  }
}

export function allCanonicalItemRelPaths(
  kind: ItemKind,
  name: string,
): string[] {
  switch (kind) {
    case "skills":
    case "pi-extensions":
      return [itemRepoRelPath(kind, name)];
    case "settings":
      return [`settings/${name}/settings.json`];
    case "subagents":
      return [`subagents/${name}/claude.md`, `subagents/${name}/codex.toml`];
    case "mcp":
      return [`mcp/${name}/claude.json`, `mcp/${name}/codex.toml`];
    case "codex-config":
      return [`codex/config/${name}/config.toml`];
    default:
      return assertNever(kind);
  }
}

export async function canonicalItemRelPaths(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string[]> {
  if (isCopyDirectoryItemKind(kind)) return [itemRepoRelPath(kind, name)];
  if (isCopyTargetFileItemKind(kind)) {
    return allCanonicalItemRelPaths(kind, name).filter((relPath) =>
      existsSync(join(dataRepo, ...relPath.split("/"))),
    );
  }
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

export function masterListDir(dataRepo: string, kind: ItemKind): string {
  switch (kind) {
    case "pi-extensions":
      return join(dataRepo, "pi", "extensions");
    case "codex-config":
      return join(dataRepo, "codex", "config");
    case "subagents":
    case "skills":
    case "settings":
    case "mcp":
      return join(dataRepo, kind);
    default:
      return assertNever(kind);
  }
}

async function isInstallableDataItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<boolean> {
  switch (kind) {
    case "skills":
      return true;
    case "pi-extensions":
      return existsSync(
        join(dataRepo, ...itemRepoRelPath(kind, name).split("/"), "index.ts"),
      );
    case "subagents":
    case "settings":
    case "mcp":
    case "codex-config":
      return allCanonicalItemRelPaths(kind, name).some((relPath) =>
        existsSync(join(dataRepo, ...relPath.split("/"))),
      );
    default:
      return assertNever(kind);
  }
}
