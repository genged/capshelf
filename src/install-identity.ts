import type { GitReadMemo } from "./git-read-memo";
import { existsSync } from "node:fs";
import { installedPath, itemOutputTargets } from "./installed";
import type { LockEntry } from "./lock";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";
import { inventoryLocalTree } from "./gitignore";
import { installedVisiblePaths } from "./installed-visibility";
import type { Scope } from "./promote-core";
import type { GitTreeSource } from "./item-source";
import { classifyInstalledFile, type InstallDifference } from "./install-diff";
import type { ItemKind } from "./master";
import {
  hashWidthOf,
  installedPinDigest,
  itemTreeEntriesAtCommit,
  observeInstalledEntries,
  readEntryBytes,
  sourcePinDigest,
  targetsUnderRoot,
} from "./pin";
import type { InstalledTarget, PinTreeEntry } from "./pin";

/**
 * Never mix the two identity models in one comparison: they answer different
 * questions, and a silent mix recreates the disagreement that lock version 4
 * removed.
 */
export function isTreePinned(entry: LockEntry): boolean {
  return entry.source === "data" && entry.sourcePinDigest !== undefined;
}

export function installedTargetsForItem(
  project: string,
  kind: ItemKind,
  name: string,
  entries: readonly PinTreeEntry[],
): InstalledTarget[] | null {
  if (isCopyDirectoryItemKind(kind)) {
    return targetsUnderRoot(installedPath(project, kind, name), entries);
  }
  if (isCopyTargetFileItemKind(kind)) {
    const itemRoot = itemRepoRelPath(kind, name);
    const byCanonicalPath = new Map(
      itemOutputTargets(project, kind, name).map((target) => [
        target.canonicalRelPath,
        target.outputPath,
      ]),
    );
    const targets: InstalledTarget[] = [];
    for (const entry of entries) {
      const outputPath = byCanonicalPath.get(`${itemRoot}/${entry.path}`);
      if (outputPath === undefined) continue;
      targets.push({ path: entry.path, absolutePath: outputPath });
    }
    return targets;
  }
  // Fragments merge into shared outputs, so no installed file maps to a pinned
  // source.
  return null;
}

export type InstallationAxis =
  | "clean"
  | "modified"
  | "missing"
  | "visible-extra"
  | "hidden-extra"
  | "unsupported";

export interface InstallationReport {
  axis: InstallationAxis;
  currentSha: string | null;
  pinnedSha: string;
  differences: InstallDifference[];
  hiddenExtras: string[];
  /**
   * `status` shows visible extras because `update` and `apply` delete them
   * under consent.
   */
  visibleExtras: string[];
}

export async function describeInstallation(
  project: string,
  source: GitTreeSource,
  kind: ItemKind,
  name: string,
  scope: Scope,
  memo?: GitReadMemo,
): Promise<InstallationReport | null> {
  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(source, kind, memo);
  } catch {
    return null;
  }
  const targets = installedTargetsForItem(project, kind, name, entries);
  if (targets === null || targets.length === 0) return null;
  const width = hashWidthOf(entries);
  const observed = await observeInstalledEntries(targets, width, {
    keepBytes: true,
  });
  const pinnedById = new Map(entries.map((entry) => [entry.path, entry]));

  const differences: InstallDifference[] = [];
  const differingPaths: PinTreeEntry[] = [];
  for (const observation of observed) {
    const pinned = pinnedById.get(observation.path)!;
    if (observation.missing === true) {
      differences.push({ path: observation.path, kind: "missing" });
      continue;
    }
    if (observation.unusable !== undefined) {
      differences.push({ path: observation.path, kind: observation.unusable });
      continue;
    }
    if (
      observation.blobId === pinned.blobId &&
      observation.mode === pinned.mode
    ) {
      continue;
    }
    if (observation.blobId === pinned.blobId) {
      differences.push({
        path: observation.path,
        kind: "mode",
        modeChanged: true,
      });
      continue;
    }
    differingPaths.push(pinned);
  }

  if (differingPaths.length > 0) {
    const bytes = new Map(
      (await readEntryBytes(source.repo, differingPaths, memo)).map((file) => [
        file.path,
        file.content,
      ]),
    );
    for (const observation of observed) {
      if (!bytes.has(observation.path)) continue;
      const pinned = pinnedById.get(observation.path)!;
      differences.push(
        classifyInstalledFile({
          path: observation.path,
          installed: observation.bytes ?? Buffer.alloc(0),
          pinned: bytes.get(observation.path)!,
          installedMode: observation.mode ?? "100644",
          pinnedMode: pinned.mode,
        }),
      );
    }
  }

  const { hiddenExtras, visibleExtras } = await unpinnedExtraPaths(
    project,
    kind,
    name,
    entries,
    scope,
  );
  const currentSha = sourcePinDigest(
    observed.map((observation) => ({
      path: observation.path,
      mode: observation.mode ?? "100644",
      blobId:
        observation.blobId ??
        (observation.missing === true ? "(missing)" : "(unreadable)"),
      repoRelPath: observation.path,
    })),
  );
  const pinnedSha = sourcePinDigest(entries);
  const allMissing = observed.every(
    (observation) => observation.missing === true,
  );
  const unsupported = observed.some(
    (observation) => observation.unusable !== undefined,
  );
  const axis: InstallationAxis = unsupported
    ? "unsupported"
    : allMissing
      ? "missing"
      : currentSha !== pinnedSha
        ? "modified"
        : visibleExtras.length > 0
          ? "visible-extra"
          : hiddenExtras.length > 0
            ? "hidden-extra"
            : "clean";
  return {
    axis,
    currentSha,
    pinnedSha,
    differences,
    hiddenExtras,
    visibleExtras,
  };
}

/**
 * Hidden extras are preserved, so not drift, but still readable by agents
 * enumerating the directory; visible extras get deleted under consent, so
 * `status` must not call the item clean.
 */
async function unpinnedExtraPaths(
  project: string,
  kind: ItemKind,
  name: string,
  entries: readonly PinTreeEntry[],
  scope: Scope,
): Promise<{ hiddenExtras: string[]; visibleExtras: string[] }> {
  const none = { hiddenExtras: [], visibleExtras: [] };
  if (!isCopyDirectoryItemKind(kind)) return none;
  const root = installedPath(project, kind, name);
  if (!existsSync(root)) return none;
  const pinned = new Set(entries.map((entry) => entry.path));
  const inventory = await inventoryLocalTree(root);
  const raw = [
    ...inventory.files,
    ...inventory.irregular.map((object) => object.path),
  ].filter((path) => !pinned.has(path) && !isMetadataSidecarPath(path));
  if (raw.length === 0) return none;
  const visible = await installedVisiblePaths({
    project,
    root,
    kind,
    name,
    candidates: raw,
    scope,
  });
  return {
    hiddenExtras: raw.filter((path) => !visible.has(path)).sort(),
    visibleExtras: raw.filter((path) => visible.has(path)).sort(),
  };
}

/**
 * Installed files are named with Git's own blob-id formula, and no blob is
 * read, because the pinned ids come from ls-tree. A clean install therefore
 * digests to exactly `entry.sourcePinDigest`.
 */
export async function installedTreeIdentity(
  project: string,
  source: GitTreeSource,
  kind: ItemKind,
  name: string,
): Promise<string | null> {
  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(source, kind);
  } catch {
    return null;
  }
  const targets = installedTargetsForItem(project, kind, name, entries);
  if (targets === null || targets.length === 0) return null;
  if (!targets.some((target) => existsSync(target.absolutePath))) return null;
  return await installedPinDigest(targets, hashWidthOf(entries));
}
