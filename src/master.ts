import { lstat, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { hashNamedContents } from "./content-hash";
import { assertNever, assertSafeItemName } from "./assert";
import { isIgnoredDotDirent } from "./dotfiles";
import {
  projectVisibleFilesUnderPath,
  sourceVisibleFilesUnderPath,
} from "./git";
import { METADATA_SIDECAR } from "./identity";
import { PreconditionError } from "./errors";

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

/**
 * Same test for a kind that has already been widened to `string` — result rows
 * from `apply`/`update` carry `kind` that way, and the all-or-nothing preflight
 * gate is scoped by it.
 */
export function isFragmentKindName(value: string): value is FragmentItemKind {
  return (FRAGMENT_ITEM_KINDS as readonly string[]).includes(value);
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

/*
 * THE OBJECT MODEL
 *
 * Every call site that walks a managed directory must classify what it finds
 * against this table instead of improvising a rule.
 *
 * There are five populations, not two. Git visibility is the line between
 * drift (row 3, reconciled away under consent) and local state (row 4,
 * carried across a replacement). Before this table was written down, each
 * call site rediscovered the boundary and drew it differently: one refused
 * symlinks in ignored local state, another normalized real file modes to
 * Git's two-value model, a third hard-failed on the sidecar.
 *
 * | # | Population | Policy | Enforced by |
 * | - | ---------- | ------ | ----------- |
 * | 1 | Item content in the data-repo working tree | Regular files only, Git modes. Symlinks refused — trust boundary | `gitignoreVisibleFiles` |
 * | 2 | Item content at a commit | Regular blobs only, sidecar filtered | `assertRegularBlobEntries`, `materializableFilesAtCommit` |
 * | 3 | Git-visible content inside an installed directory that is not managed | Drift. Reconciled away under consent as `extra_local_path`; Git modes apply, so `executable_mode` is a real change | `visiblePaths` in `copyDirectoryReconciliationFiles` |
 * | 4 | Ignored local state under an installed directory | Carried across as-is: real `stat` modes, symlinks preserved by target, never hashed or published. Non-recreatable objects (fifo, socket, device) refused on write, listed on remove | `inventoryLocalTree` + `PreservedEntry` |
 * | 5 | `.capshelf.yml` | Excluded from hashing and materialization everywhere; for reconciliation, treated as row 4 regardless of Git visibility | `isMetadataSidecarPath` at each boundary |
 *
 * Rows 1 and 2 are the trust boundary: item content crossing into or out of
 * the data repo is Git's object model, and nothing below may widen it. Row 4
 * never crosses that boundary — those files came from the user's filesystem
 * and go back to the same path, so capshelf never reads through them, hashes
 * them, or publishes them, and Git's object model does not apply.
 */

/**
 * True when an item-root-relative path is the item's metadata sidecar.
 * `rel` must be relative to the item root: the check is exactly
 * `rel === ".capshelf.yml"`, never a basename match — nested
 * `sub/.capshelf.yml` files are item content and stay hashed/materialized.
 * The sidecar is catalog data only; it is excluded from every hashing path
 * and from materialization so metadata edits never look like content drift
 * (row 5 of the object-model table above).
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
      else {
        const type = e.isSymbolicLink()
          ? "symlink"
          : "unsupported filesystem object";
        throw new PreconditionError(
          `${root} contains an unsupported ${type}: ${childRel}; copy items support regular files only`,
        );
      }
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
    (await walkFiles(itemPath)).filter((rel) => !isMetadataSidecarPath(rel)),
  );
}

/**
 * The legacy (lock version 3) content hash of a data-repo item, taken over the
 * files Git treats as owned in the *data repo working tree*. Bound to the
 * `source-read` profile.
 *
 * Under lock version 4 this is no longer an identity: `sourcePinDigest`
 * (`src/pin.ts`) is, and it comes from the committed tree. This survives for
 * catalog display and for the one-time migration audit in `lock migrate`.
 */
export async function shaOfGitVisibleItem(
  repo: string,
  relPath: string,
): Promise<string> {
  return shaOfItemFiles(
    join(repo, ...relPath.split("/")),
    (await sourceVisibleFilesUnderPath(repo, relPath)).filter(
      (rel: string) => !isMetadataSidecarPath(rel),
    ),
  );
}

/** The same hash over an installed item, using the *project's* Git policy. */
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
