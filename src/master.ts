import { lstat, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { hashNamedContents } from "./content-hash";
import { assertNever, assertSafeItemName } from "./assert";
import { isIgnoredDotDirent } from "./dotfiles";
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigValue } from "./config-values";
import { lstatOrNull } from "./fs-utils";
import {
  projectVisibleFilesUnderPath,
  sourceVisibleFilesUnderPath,
  type VisibleFilesLister,
} from "./git";
import { HOME_ENV, METADATA_SIDECAR, PRODUCT_NAME } from "./identity";
import { PreconditionError } from "./errors";

export const ITEM_KINDS = [
  "skills",
  "plugins",
  "pi-extensions",
  "subagents",
  "settings",
  "mcp",
  "codex-config",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const COPY_DIRECTORY_ITEM_KINDS = [
  "skills",
  "plugins",
  "pi-extensions",
] as const;
export type CopyDirectoryItemKind = (typeof COPY_DIRECTORY_ITEM_KINDS)[number];

export type SkillTargetKind = "skills" | "plugins";

export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";

export function installsAtSkillTarget(kind: ItemKind): kind is SkillTargetKind {
  return kind === "skills" || kind === "plugins";
}

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
  return ITEM_KINDS.some((kind) => kind === value);
}

export function parseItemKind(value: string): ItemKind {
  if (isItemKind(value)) return value;
  throw new PreconditionError(
    `invalid kind "${value}"; must be one of ${ITEM_KINDS.join(", ")}`,
  );
}

export function isCopyDirectoryItemKind(
  value: ItemKind,
): value is CopyDirectoryItemKind {
  return COPY_DIRECTORY_ITEM_KINDS.some((kind) => kind === value);
}

export function isCopyTargetFileItemKind(
  value: ItemKind,
): value is CopyTargetFileItemKind {
  return COPY_TARGET_FILE_ITEM_KINDS.some((kind) => kind === value);
}

export function isFragmentItemKind(value: ItemKind): value is FragmentItemKind {
  return FRAGMENT_ITEM_KINDS.some((kind) => kind === value);
}

export function isFragmentKindName(value: string): value is FragmentItemKind {
  return FRAGMENT_ITEM_KINDS.some((kind) => kind === value);
}

export function isMaterializedItemKind(
  value: ItemKind,
): value is MaterializedItemKind {
  return isCopyDirectoryItemKind(value) || isCopyTargetFileItemKind(value);
}

export function itemStrategy(kind: ItemKind): ItemStrategy {
  switch (kind) {
    case "skills":
    case "plugins":
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
  path: string;
  repoRelPath: string;
}

export function assertDataRepoExists(dataRepo: string): string {
  if (!existsSync(dataRepo)) {
    throw new Error(
      // No fallback path is suggested because there is no implicit default data
      // repo.
      `data repo not found at ${dataRepo}\n` +
        `  pass --data <path>, bind one with \`${PRODUCT_NAME} data bind <path>\`, or set $${HOME_ENV}`,
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
      if (e.isSymbolicLink()) {
        throw new PreconditionError(
          `${join(dir, e.name)} is an unsupported symlink; copy items support regular directories only`,
        );
      }
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      assertSafeItemName(e.name, `data repo ${k} catalog`);
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
 * Core invariants: (1) Item content in the data-repo working tree allows
 * regular files only, with Git modes. Symlinks are refused. (2) Item content at
 * a commit allows regular blobs only, with the sidecar filtered. (3)
 * Git-visible extras in an installed directory are drift, reconciled away under
 * consent. (4) Ignored local state returns to the same path, so preserve real
 * modes and symlink targets; never read through these links, hash this state,
 * or publish it. Fifos, sockets, and devices are refused on write and listed on
 * remove. (5) `.capshelf.yml` is excluded from hashing and materialization
 * everywhere, and is treated as (4) for reconciliation. (1) and (2) are the
 * trust boundary and nothing below may widen it. Git visibility separates drift
 * from local state.
 */

/**
 * Exact match on the item-root-relative path, never a basename match, because
 * nested `sub/.capshelf.yml` files are item content.
 */
export function isMetadataSidecarPath(rel: string): boolean {
  return rel === METADATA_SIDECAR;
}

export async function walkItemFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function go(rel: string): Promise<void> {
    const abs = rel ? join(root, rel) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      if (isIgnoredDotDirent(e)) continue;
      const childRel = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) await go(childRel);
      else if (e.isFile()) out.push(childRel);
      else if (e.isSymbolicLink()) {
        throw new PreconditionError(
          `${root} contains an unsupported symlink: ${childRel}; copy items support regular files only`,
          {
            hint: "Dependency installs create symlinks, for example node_modules from pnpm. Delete the path, then run the command again.",
          },
        );
      } else {
        throw new PreconditionError(
          `${root} contains an unsupported filesystem object: ${childRel}; copy items support regular files only`,
        );
      }
    }
  }
  await go("");
  out.sort();
  return out;
}

export async function shaOfItem(itemPath: string): Promise<string> {
  const info = await lstat(itemPath);
  if (info.isFile()) {
    return shaOfItemFiles(itemPath, []);
  }
  if (!info.isDirectory()) {
    throw new PreconditionError(
      `${itemPath} is not a regular file or directory; copy items do not support symlinks or special files`,
    );
  }
  return shaOfItemFiles(
    itemPath,
    (await walkItemFiles(itemPath)).filter(
      (rel) => !isMetadataSidecarPath(rel),
    ),
  );
}

/**
 * Content hash over the files Git treats as owned in the data repo working
 * tree, the identity of lock versions 2 and 3. From version 4 on, identity is
 * `sourcePinDigest` from the committed tree. This hash serves catalog and
 * comparison facts and the `lock migrate` audit.
 */
export async function shaOfGitVisibleItem(
  repo: string,
  relPath: string,
  listFiles: VisibleFilesLister = (path) =>
    sourceVisibleFilesUnderPath(repo, path),
): Promise<string> {
  return shaOfItemFiles(
    join(repo, ...relPath.split("/")),
    (await listFiles(relPath)).filter(
      (rel: string) => !isMetadataSidecarPath(rel),
    ),
  );
}

export async function shaOfProjectVisibleItem(
  project: string,
  relPath: string,
): Promise<string> {
  return shaOfItemFiles(
    join(project, ...relPath.split("/")),
    (await projectVisibleFilesUnderPath(project, relPath)).filter(
      (rel: string) => !isMetadataSidecarPath(rel),
    ),
  );
}

export async function shaOfItemFiles(
  itemPath: string,
  files: string[],
): Promise<string> {
  const info = await lstat(itemPath);
  const named = info.isFile()
    ? [{ name: basename(itemPath), path: itemPath }]
    : files.map((rel) => ({
        name: rel,
        path: join(itemPath, ...rel.split("/")),
      }));
  return hashNamedContents(
    await Promise.all(
      named.map(async ({ name, path }) => {
        const file = await lstat(path);
        if (!file.isFile()) {
          throw new PreconditionError(
            `${itemPath} contains a non-regular file: ${name}; copy items support regular files only`,
          );
        }
        return { name, content: await readFile(path) };
      }),
    ),
  );
}

export function itemRepoRelPath(kind: ItemKind, name: string): string {
  switch (kind) {
    case "skills":
      return `skills/${name}`;
    case "plugins":
      return `plugins/${name}`;
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

/**
 * Kind decides the layout and the content source decides the root, so an item
 * can be read at a non-canonical root without a second path rule.
 */
export function itemRelPathsWithinRoot(kind: ItemKind): readonly string[] {
  switch (kind) {
    case "skills":
    case "plugins":
    case "pi-extensions":
      return [];
    case "settings":
      return ["settings.json"];
    case "subagents":
      return ["claude.md", "codex.toml"];
    case "mcp":
      return ["claude.json", "codex.toml"];
    case "codex-config":
      return ["config.toml"];
    default:
      return assertNever(kind);
  }
}

export function allCanonicalItemRelPaths(
  kind: ItemKind,
  name: string,
): string[] {
  const itemRoot = itemRepoRelPath(kind, name);
  if (isCopyDirectoryItemKind(kind)) return [itemRoot];
  return itemRelPathsWithinRoot(kind).map((rel) => `${itemRoot}/${rel}`);
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
    case "plugins":
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
    case "plugins":
      return isInstallablePlugin(dataRepo, name);
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

export async function readPluginManifestName(
  manifestPath: string,
): Promise<string | null> {
  const stat = lstatOrNull(manifestPath);
  if (!stat?.isFile()) return null;
  try {
    const parsed: ConfigValue = JSON.parse(
      await readFile(manifestPath, "utf-8"),
    );
    return isConfigObject(parsed) && isConfigString(parsed.name)
      ? parsed.name
      : null;
  } catch {
    return null;
  }
}

async function isInstallablePlugin(
  dataRepo: string,
  name: string,
): Promise<boolean> {
  const manifestPath = join(
    dataRepo,
    ...itemRepoRelPath("plugins", name).split("/"),
    ...PLUGIN_MANIFEST_REL.split("/"),
  );
  return (await readPluginManifestName(manifestPath)) === name;
}
