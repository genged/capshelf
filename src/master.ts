import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { isIgnoredDotDirent } from "./dotfiles";
import { gitVisibleFilesUnderPath } from "./git";
import { METADATA_SIDECAR } from "./metadata";

export const ITEM_KINDS = [
  "skills",
  "settings",
  "mcp",
  "codex-config",
  "okf",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const FRAGMENT_ITEM_KINDS = ["settings", "mcp", "codex-config"] as const;
export type FragmentItemKind = (typeof FRAGMENT_ITEM_KINDS)[number];

/**
 * The behavioral shape of an item kind. This is the real axis the codebase
 * branches on; before the registry it was encoded negatively as
 * `=== "skills"` / `!== "skills"`, which silently conflated "is a fragment"
 * with "is a skill" because skills was the only non-fragment kind.
 *
 * - `fragment`: partial values merged into a shared generated output file
 *   (`.claude/settings.json`, `.mcp.json`, `.codex/config.toml`).
 * - `skill`: a Claude/Codex skill directory — `.claude/skills` symlink,
 *   `SKILL.md`, install-mode awareness, external-state, frontmatter catalog.
 * - `okf`: an Open Knowledge Format bundle directory — copied wholesale to a
 *   configurable output dir, no symlink, not mode-aware.
 */
export type ItemShape = "fragment" | "skill" | "okf";

/** Manifest array key that records the installed names for a kind. */
export type ManifestListKey =
  | "skills"
  | "settings"
  | "mcp"
  | "codexConfig"
  | "okf";

export interface ItemKindDescriptor {
  kind: ItemKind;
  shape: ItemShape;
  /** Directory under the data repo root that holds items of this kind. */
  repoDir: string;
  /**
   * Source files inside an item that are canonical for a fragment kind,
   * relative to the item directory. Empty for whole-directory kinds
   * (skills, okf), whose entire tree is the item.
   */
  canonicalFiles: string[];
  /** Manifest array that records installed names for this kind. */
  manifestKey: ManifestListKey;
}

export const ITEM_KIND_DESCRIPTORS: Record<ItemKind, ItemKindDescriptor> = {
  skills: {
    kind: "skills",
    shape: "skill",
    repoDir: "skills",
    canonicalFiles: [],
    manifestKey: "skills",
  },
  settings: {
    kind: "settings",
    shape: "fragment",
    repoDir: "settings",
    canonicalFiles: ["settings.json"],
    manifestKey: "settings",
  },
  mcp: {
    kind: "mcp",
    shape: "fragment",
    repoDir: "mcp",
    canonicalFiles: ["claude.json", "codex.toml"],
    manifestKey: "mcp",
  },
  "codex-config": {
    kind: "codex-config",
    shape: "fragment",
    repoDir: "codex/config",
    canonicalFiles: ["config.toml"],
    manifestKey: "codexConfig",
  },
  okf: {
    kind: "okf",
    shape: "okf",
    repoDir: "okf",
    canonicalFiles: [],
    manifestKey: "okf",
  },
};

export function descriptorFor(kind: ItemKind): ItemKindDescriptor {
  return ITEM_KIND_DESCRIPTORS[kind];
}

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/** Merges into a shared generated output file. */
export function isFragmentItemKind(value: ItemKind): value is FragmentItemKind {
  return descriptorFor(value).shape === "fragment";
}

/** A Claude/Codex skill, with skill-only install semantics. */
export function isSkillKind(value: ItemKind): boolean {
  return descriptorFor(value).shape === "skill";
}

/** Materialized as a self-contained directory tree, not a merged fragment. */
export function isDirectoryKind(value: ItemKind): boolean {
  return descriptorFor(value).shape !== "fragment";
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
 * Hash an item's content. Works on both directories (skills, settings,
 * mcp fragments) and single files (future codex agents).
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
  return `${descriptorFor(kind).repoDir}/${name}`;
}

export function allCanonicalItemRelPaths(
  kind: ItemKind,
  name: string,
): string[] {
  const { canonicalFiles } = descriptorFor(kind);
  const itemPath = itemRepoRelPath(kind, name);
  if (canonicalFiles.length === 0) return [itemPath];
  return canonicalFiles.map((file) => `${itemPath}/${file}`);
}

export async function canonicalItemRelPaths(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string[]> {
  if (isDirectoryKind(kind)) return [itemRepoRelPath(kind, name)];
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
  return join(dataRepo, ...descriptorFor(kind).repoDir.split("/"));
}

async function isInstallableDataItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<boolean> {
  if (isDirectoryKind(kind)) return true;
  return allCanonicalItemRelPaths(kind, name).some((relPath) =>
    existsSync(join(dataRepo, ...relPath.split("/"))),
  );
}
