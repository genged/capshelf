import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NamedFile } from "./merge-tree";
import { inventoryLocalTree } from "./gitignore";
import { findDestinationPathCollision } from "./path-collision";
import { PreconditionError } from "./errors";

export interface PromoteTransactionHooks {
  afterPrepared?: () => Promise<void>;
  afterPathReplaced?: () => Promise<void>;
  beforeHeadAdvance?: () => Promise<void>;
}

export interface InstalledReconciliation {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function beginDirectoryReplacement(
  target: string,
  prepare: (replacement: string) => Promise<void>,
): Promise<InstalledReconciliation> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const transactionDir = await mkdtemp(join(parent, ".capshelf-materialize-"));
  const replacement = join(transactionDir, "replacement");
  const backup = join(transactionDir, "original");
  let hadOriginal = false;

  try {
    await prepare(replacement);
    try {
      await rename(target, backup);
      hadOriginal = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(replacement, target);
    } catch (error) {
      if (hadOriginal) await rename(backup, target);
      throw error;
    }
  } catch (error) {
    await rm(transactionDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await rm(transactionDir, { recursive: true, force: true }).catch(
        () => {},
      );
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await rm(target, { recursive: true, force: true });
      if (hadOriginal) await rename(backup, target);
      await rm(transactionDir, { recursive: true, force: true }).catch(
        () => {},
      );
    },
  };
}

export async function beginInstalledReconciliation(
  installedDir: string,
  localFiles: NamedFile[],
  mergedFiles: NamedFile[],
): Promise<InstalledReconciliation> {
  const parent = dirname(installedDir);
  const backupDir = await mkdtemp(join(parent, ".capshelf-promote-"));
  const backup = join(backupDir, "original");
  await rename(installedDir, backup);
  try {
    const replaceableIrregularPaths =
      await assertFrozenPreservedPathsDoNotCollide(
        backup,
        localFiles,
        mergedFiles,
      );
    await cp(backup, installedDir, {
      recursive: true,
      preserveTimestamps: true,
    });
    for (const path of replaceableIrregularPaths) {
      await rm(join(installedDir, ...path.split("/")), { force: true });
    }
    for (const file of [...localFiles].sort(
      (a, b) => b.path.length - a.path.length,
    )) {
      const path = join(installedDir, ...file.path.split("/"));
      await rm(path, { force: true });
      await pruneEmptyParents(dirname(path), installedDir);
    }
    for (const file of mergedFiles) {
      const path = join(installedDir, ...file.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
      await chmod(path, file.mode === "100755" ? 0o755 : 0o644);
    }
  } catch (error) {
    await rm(installedDir, { recursive: true, force: true });
    await rename(backup, installedDir);
    await rm(backupDir, { recursive: true, force: true });
    throw error;
  }

  let finished = false;
  return {
    async commit() {
      if (finished) return;
      finished = true;
      await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    },
    async rollback() {
      if (finished) return;
      finished = true;
      await rm(installedDir, { recursive: true, force: true });
      await rename(backup, installedDir);
      await rm(backupDir, { recursive: true, force: true });
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
