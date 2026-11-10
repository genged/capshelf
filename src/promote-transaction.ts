import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NamedFile } from "./merge-tree";
import { inventoryLocalTree } from "./gitignore";
import { findDestinationPathCollision } from "./path-collision";
import { firstErrorLine, PreconditionError } from "./errors";
import { ensureDir } from "./fs-utils";
import { assertInScope, type MutationScope } from "./path-safety";
import {
  assertNoManagedPathOnMount,
  attachTree,
  carriedUnits,
  clearTree,
  copyTree,
  detachTree,
  holding,
  moveUnits,
  readMountLayout,
  removeScratchTree,
  returnUnits,
  splitMovableUnits,
  type MountLayout,
} from "./mount-points";

export interface PromoteTransactionHooks {
  afterPrepared?: () => Promise<void>;
  afterPathReplaced?: () => Promise<void>;
  beforeHeadAdvance?: () => Promise<void>;
}

export interface InstalledReconciliation {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Replace `target` with the folder that `prepare` writes. `prepare` gets the
 * mount points inside `target`: they stay in place, so it must not write a
 * path on one. It returns the row-4 units to carry across: each one moves
 * from the old folder into the new one with a rename, so its bytes are never
 * read. A read-only unit cannot move to a new parent, so it stays in place
 * like a mount point. Without mounts and held units, the folder itself moves
 * with one rename each way. `scope` confines `target`, its parent, and the
 * scratch folder.
 */
export async function beginDirectoryReplacement(
  target: string,
  scope: MutationScope,
  prepare: (
    replacement: string,
    layout: MountLayout,
  ) => Promise<readonly string[] | undefined>,
): Promise<InstalledReconciliation> {
  const parent = dirname(target);
  await ensureDir(parent, scope);
  await assertInScope(scope, target);
  const mounts = await readMountLayout(target);
  // The mount points, plus the units that stay in place.
  let layout = mounts;
  const transactionDir = await mkdtemp(join(parent, ".capshelf-materialize-"));
  const replacement = join(transactionDir, "replacement");
  const backup = join(transactionDir, "original");
  let detached = false;
  // True once `target` may hold entries of the new tree.
  let attachStarted = false;
  let units: readonly string[] = [];

  // The rollback order matters: units go back to the old folder first, so the
  // clear of `target` never deletes one. `target` is cleared only after the
  // attach started, because before that it holds only pinned folders and
  // mount points, or nothing.
  const restore = async () => {
    if (detached) {
      await returnUnits(units, [target, replacement], backup, scope);
    }
    if (attachStarted) await clearTree(target, layout, scope);
    if (detached) await attachTree(backup, target, layout, scope);
  };

  try {
    units = (await prepare(replacement, mounts)) ?? [];
    if (existsSync(target)) {
      const split = await splitMovableUnits(target, units);
      units = split.movable;
      layout = holding(mounts, split.held);
      await detachOrUndo(target, backup, layout, scope);
      detached = true;
    } else {
      units = [];
    }
    await moveUnits(units, backup, replacement, scope);
    // One rename moves all or nothing. A move around mounts can stop part way.
    attachStarted = layout.pinned.size > 0;
    await attachTree(replacement, target, layout, scope);
    attachStarted = true;
  } catch (error) {
    await restoreOrKeep(restore, firstErrorLine(error), backup);
    await removeScratchTree(transactionDir, scope).catch(() => {});
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await removeCommittedScratch(transactionDir, scope);
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await restoreOrKeep(restore, null, backup);
      await removeScratchTree(transactionDir, scope);
    },
  };
}

/**
 * Remove the scratch folder after a commit. The new tree is in place by then,
 * and a rollback can no longer run, so a failure here is a warning and not
 * an error: an error would report a write that did happen as failed.
 */
async function removeCommittedScratch(
  path: string,
  scope: MutationScope,
): Promise<void> {
  try {
    await removeScratchTree(path, scope);
  } catch (error) {
    process.stderr.write(
      `! could not delete the scratch folder ${path} (${firstErrorLine(error)}). The new files are in place. Delete the folder by hand.\n`,
    );
  }
}

/**
 * Move the contents of `target` to `backup`. If that fails part way, move
 * back what moved, so `target` is as it was, and rethrow. With mounts, this
 * creates `backup` first: when that fails, nothing moved, and a path that was
 * already there is never taken for moved entries.
 */
async function detachOrUndo(
  target: string,
  backup: string,
  layout: MountLayout,
  scope: MutationScope,
): Promise<void> {
  if (layout.pinned.size === 0) {
    await detachTree(target, backup, layout, scope);
    return;
  }
  await assertInScope(scope, backup);
  await mkdir(backup);
  try {
    await detachTree(target, backup, layout, scope);
  } catch (error) {
    try {
      await attachTree(backup, target, layout, scope);
    } catch (undoError) {
      throw new Error(
        `${firstErrorLine(error)}; moving the moved entries back also failed (${firstErrorLine(undoError)}). They are in ${backup}.`,
        { cause: undoError },
      );
    }
    throw error;
  }
}

/**
 * Run `restore`. If it fails, keep the scratch folder, because it holds the
 * previous install, and say where it is.
 */
async function restoreOrKeep(
  restore: () => Promise<void>,
  failure: string | null,
  backup: string,
): Promise<void> {
  try {
    await restore();
  } catch (restoreError) {
    const reason = failure === null ? "" : `${failure}; `;
    throw new Error(
      `${reason}the restore of the previous install also failed (${firstErrorLine(restoreError)}). The previous install is kept in ${backup}.`,
      { cause: restoreError },
    );
  }
}

/** One installed entry the reconciliation keeps. `content` is null for a non-regular entry. */
export interface KeptInstalledEntry {
  path: string;
  content: Buffer | null;
}

/**
 * The installed entries `beginInstalledReconciliation` keeps: it copies the
 * whole folder, deletes only `localFiles`, and writes `mergedFiles`. So every
 * entry that is in neither list stays. A consent point reads these beside
 * the merged files, from this rule and not from a parallel one.
 */
export async function keptByInstalledReconciliation(
  installedDir: string,
  localFiles: readonly NamedFile[],
  mergedFiles: readonly NamedFile[],
): Promise<KeptInstalledEntry[]> {
  const replaced = new Set([
    ...localFiles.map((file) => file.path),
    ...mergedFiles.map((file) => file.path),
  ]);
  const inventory = await inventoryLocalTree(installedDir);
  const kept: KeptInstalledEntry[] = [];
  for (const path of inventory.files) {
    if (replaced.has(path)) continue;
    kept.push({
      path,
      content: await readFile(join(installedDir, ...path.split("/"))),
    });
  }
  for (const object of inventory.irregular) {
    if (replaced.has(object.path)) continue;
    kept.push({ path: object.path, content: null });
  }
  return kept;
}

export async function beginInstalledReconciliation(
  installedDir: string,
  localFiles: NamedFile[],
  mergedFiles: NamedFile[],
  scope: MutationScope,
): Promise<InstalledReconciliation> {
  await assertInScope(scope, installedDir);
  const mounts = await readMountLayout(installedDir);
  const managedPaths = [...localFiles, ...mergedFiles].map((file) => file.path);
  await assertNoManagedPathOnMount(installedDir, mounts, managedPaths);
  // Everything this write neither deletes nor writes stays. It moves back by
  // rename, and only the managed entries are copied.
  const inventory = await inventoryLocalTree(installedDir);
  const managed = new Set(managedPaths);
  const split = await splitMovableUnits(
    installedDir,
    carriedUnits({
      kept: [
        ...inventory.files,
        ...inventory.irregular.map((object) => object.path),
      ].filter((path) => !managed.has(path)),
      blockers: managedPaths,
      layout: mounts,
    }),
  );
  const units = split.movable;
  // The mount points, plus the read-only units that stay in place.
  const layout = holding(mounts, split.held);
  const parent = dirname(installedDir);
  await assertInScope(scope, parent);
  const backupDir = await mkdtemp(join(parent, ".capshelf-promote-"));
  const backup = join(backupDir, "original");
  let detached = false;
  // After the detach, `installedDir` holds only what this write put there,
  // beside pinned folders and mount points, so the clear is safe.
  const restore = async () => {
    if (!detached) return;
    await returnUnits(units, [installedDir], backup, scope);
    await clearTree(installedDir, layout, scope);
    await attachTree(backup, installedDir, layout, scope);
  };
  try {
    await detachOrUndo(installedDir, backup, layout, scope);
    detached = true;
    const replaceableIrregularPaths =
      await assertFrozenPreservedPathsDoNotCollide(
        backup,
        localFiles,
        mergedFiles,
      );
    // With no units, `copyTree` copies the whole folder to a missing path, as
    // before. With units, the folder must exist to receive them.
    if (units.length > 0) await ensureDir(installedDir, scope);
    await moveUnits(units, backup, installedDir, scope);
    await copyTree(backup, installedDir, holding(layout, units), scope);
    for (const path of replaceableIrregularPaths) {
      const irregular = join(installedDir, ...path.split("/"));
      await assertInScope(scope, dirname(irregular));
      await rm(irregular, { force: true });
    }
    for (const file of [...localFiles].sort(
      (a, b) => b.path.length - a.path.length,
    )) {
      const path = join(installedDir, ...file.path.split("/"));
      await assertInScope(scope, dirname(path));
      await rm(path, { force: true });
      await pruneEmptyParents(dirname(path), installedDir);
    }
    for (const file of mergedFiles) {
      const path = join(installedDir, ...file.path.split("/"));
      await ensureDir(dirname(path), scope);
      await writeFile(path, file.content);
      await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
    }
  } catch (error) {
    if (detached) {
      await restoreOrKeep(restore, firstErrorLine(error), backup);
      await removeScratchTree(backupDir, scope).catch(() => {});
    } else {
      await removeScratchTree(backupDir, scope).catch(() => {});
    }
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await removeCommittedScratch(backupDir, scope);
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await restoreOrKeep(restore, null, backup);
      await removeScratchTree(backupDir, scope);
    },
  };
}

async function assertFrozenPreservedPathsDoNotCollide(
  backup: string,
  localFiles: readonly NamedFile[],
  mergedFiles: readonly NamedFile[],
): Promise<string[]> {
  const managedPaths = new Set(
    [...localFiles, ...mergedFiles].map((file) => file.path),
  );
  const inventory = await inventoryLocalTree(backup);
  const replaceableIrregularPaths = inventory.irregular
    .map((entry) => entry.path)
    .filter((path) => managedPaths.has(path));
  const preservedPaths = [
    ...inventory.files.filter((path) => !managedPaths.has(path)),
    ...inventory.irregular
      .map((entry) => entry.path)
      .filter((path) => !managedPaths.has(path)),
  ];
  const reconciledPaths = [...managedPaths];
  const collision = await findDestinationPathCollision(
    backup,
    preservedPaths,
    reconciledPaths,
  );
  if (!collision) return replaceableIrregularPaths;
  throw new PreconditionError(
    `preserved local path ${collision.left} collides with reconciled managed path ${collision.right}`,
  );
}

async function pruneEmptyParents(path: string, root: string): Promise<void> {
  let current = path;
  while (current !== root && current.startsWith(`${root}/`)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
