import { existsSync } from "node:fs";
import { installedPath, itemOutputTargets } from "./installed";
import type { LockEntry } from "./lock";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";
import { gitignoreVisibleFiles, inventoryLocalTree } from "./gitignore";
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
 * True when this entry's identity is the committed tree (lock version 4)
 * rather than a hash of the data repo's working copy (versions 2 and 3).
 *
 * Comparisons must never mix the two: they answer different questions, and a
 * silent mix would recreate exactly the disagreement version 4 removes.
 */
export function isTreePinned(entry: LockEntry): boolean {
  return entry.source === "data" && entry.sourcePinDigest !== undefined;
}

/**
 * Where each pinned entry of an item lands in the project.
 *
 * A copy-directory item installs its tree verbatim under one root. A subagent
 * has no single root: each canonical source is written to its own runtime
 * output file, so the mapping goes through `itemOutputTargets`.
 */
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
  // Fragments are merged into shared outputs, so no installed file corresponds
  // to a pinned source. Their installation axis is the contribution state.
  return null;
}

export type InstallationAxis =
  | "clean"
  | "modified"
  | "missing"
  | "hidden-extra"
  | "unsupported";

export interface InstallationReport {
  axis: InstallationAxis;
  /** The installed tree's identity, in the pin's own shape. */
  currentSha: string | null;
  /** The pin's identity at the commit that was read. */
  pinnedSha: string;
  differences: InstallDifference[];
  /** Present but unpinned paths the project's own rules hide (S11). */
  hiddenExtras: string[];
}

/**
 * The installation axis of PIN-6, in two stages.
 *
 * Stage 1 compares blob ids and reads **no Git objects**: the pinned ids came
 * from `ls-tree`, and the installed ids are computed from bytes already on
 * disk. A clean project settles here. Stage 2 fetches the pinned blobs for the
 * differing paths only — the same set `--diff` is about to render — and names
 * the kind of each difference.
 */
export async function describeInstallation(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<InstallationReport | null> {
  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(dataRepo, kind, name, commit);
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
      (await readEntryBytes(dataRepo, differingPaths)).map((file) => [
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

  const hiddenExtras = await hiddenExtraPaths(project, kind, name, entries);
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
        : hiddenExtras.length > 0
          ? "hidden-extra"
          : "clean";
  return { axis, currentSha, pinnedSha, differences, hiddenExtras };
}

/**
 * S11: a file inside a managed directory that no pin names and the project's
 * own rules hide. Reconciliation preserves it, so it is not drift — but an
 * agent that loads a skill by enumerating its directory reads it, which is why
 * the axis says so.
 */
async function hiddenExtraPaths(
  project: string,
  kind: ItemKind,
  name: string,
  entries: readonly PinTreeEntry[],
): Promise<string[]> {
  if (!isCopyDirectoryItemKind(kind)) return [];
  const root = installedPath(project, kind, name);
  if (!existsSync(root)) return [];
  const pinned = new Set(entries.map((entry) => entry.path));
  const inventory = await inventoryLocalTree(root);
  const raw = [
    ...inventory.files,
    ...inventory.irregular.map((object) => object.path),
  ].filter((path) => !pinned.has(path) && !isMetadataSidecarPath(path));
  if (raw.length === 0) return [];
  const visible = new Set(await gitignoreVisibleFiles(root).catch(() => raw));
  return raw.filter((path) => !visible.has(path)).sort();
}

/**
 * The installed identity of a tree-pinned item, in the same shape as the pin,
 * so a clean install digests to exactly `entry.sourcePinDigest`.
 *
 * PIN-6 stage 1: this reads the installed files and names them with Git's own
 * blob-id formula. It reads **no Git objects at all**, because the pinned ids
 * came from `ls-tree`. Naming the *kind* of a difference is stage 2, and it
 * runs only for the paths already known to differ.
 */
export async function installedTreeIdentity(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<string | null> {
  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(dataRepo, kind, name, commit);
  } catch {
    return null;
  }
  const targets = installedTargetsForItem(project, kind, name, entries);
  if (targets === null || targets.length === 0) return null;
  if (!targets.some((target) => existsSync(target.absolutePath))) return null;
  return await installedPinDigest(targets, hashWidthOf(entries));
}
