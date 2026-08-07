import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import type { LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  parseLockKey,
  installedPath,
} from "./installed";
import type { ItemSource } from "./installed";
import type { ItemKind } from "./master";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";
import type { CopyDirectoryItemKind } from "./master";
import { installedSnapshot, shaOfInstalledForScope } from "./item-snapshot";
import type { Scope } from "./promote-core";
import { findSystemItem, shaOfSystemItem } from "./bundled";
import {
  assertRegularBlobEntries,
  lsTreeEntriesAtCommit,
  showAtCommit,
} from "./git";
import type { GitTreeEntry } from "./git";
import { hasIgnoredDotSegment } from "./dotfiles";
import { runtimeWarningsForItem } from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import { missingSourceCommitMessage } from "./upstream-check";
import type { NamedFile } from "./merge-tree";
import { namedFilesEqual } from "./merge-tree";
import { gitignoreVisibleFiles, inventoryLocalTree } from "./gitignore";
import { beginDirectoryReplacement } from "./promote-transaction";
import { shaOfNamedFiles } from "./item-snapshot";
import { PRODUCT_NAME } from "./identity";
import { PreconditionError } from "./errors";

export type MaterializeAction =
  | "reconciled"
  | "would-reconcile"
  | "already-current"
  | "kept-local";

export interface MaterializeResult {
  key: string;
  source: ItemSource;
  kind: ItemKind;
  name: string;
  action: MaterializeAction;
  path: string;
  sha: string | null;
  currentSha?: string | null;
  plannedSha?: string | null;
  dryRun?: true;
  message?: string;
  runtimeWarnings?: RuntimeWarning[];
}

export interface MaterializeHooks {
  beforeSourceRead?: (path: string, index: number) => Promise<void>;
  beforeStagedWrite?: (path: string, index: number) => Promise<void>;
  afterStagedWrite?: (path: string, index: number) => Promise<void>;
  beforeStagedChmod?: (path: string, index: number) => Promise<void>;
  afterStagedChmod?: (path: string, index: number) => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
}

export interface MaterializeOptions {
  project: string;
  dataRepo?: string;
  manifest?: Manifest;
  key: string;
  entry: LockEntry;
  /** Previous lock snapshot used to distinguish stale managed paths from
   * ignored local-only files while replacing a directory. */
  previousEntry?: LockEntry;
  /**
   * Lock scope the entry came from — not inferable from `entry.local`, which
   * records intentional divergence. Local-scope installs are Git-excluded, so
   * their current-state hashing must not consult project Git visibility.
   */
  scope: Scope;
  ignoreLocal?: boolean;
  dryRun?: boolean;
  hooks?: MaterializeHooks;
}

/**
 * Row 4 of the object-model table in `master.ts`: ignored local state under a
 * managed directory, carried across a directory replacement as-is. This is
 * deliberately not `NamedFile` — these paths never cross a Git boundary, so
 * they keep their real `stat` mode instead of collapsing to `100644`/`100755`,
 * and a symlink is recreated by target rather than refused. `NamedFile` stays
 * the Git-boundary type shared with merge-tree, promote, and the tree code.
 */
export type PreservedEntry =
  | { kind: "file"; path: string; content: Buffer; mode: number }
  | { kind: "symlink"; path: string; target: string };

export interface CopyDirectoryReconciliationFiles {
  /** Rows 1–3: managed content, Git modes, Git rules. */
  expected: NamedFile[];
  /** Rows 4–5. */
  preserved: PreservedEntry[];
}

export async function materializeLockEntry(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const { source, kind, name } = parseLockKey(opts.key);
  if (isFragmentItemKind(kind)) {
    throw new Error(
      `${kind}/${name} is a fragment item and must be reconciled through fragment outputs`,
    );
  }
  if (isCopyTargetFileItemKind(kind)) {
    throw new Error(
      `${kind}/${name} must be reconciled through copy-target-file outputs`,
    );
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no materialization strategy for ${kind}/${name}`);
  }
  const dst = installedPath(opts.project, kind, name);

  if (opts.entry.source !== source) {
    throw new Error(
      `lock key ${opts.key} source does not match entry source ${opts.entry.source}`,
    );
  }

  if (
    opts.entry.source === "data" &&
    opts.entry.local === true &&
    !opts.ignoreLocal
  ) {
    return {
      key: opts.key,
      source,
      kind,
      name,
      action: "kept-local",
      path: dst,
      sha: await shaOfInstalledForScope(opts.project, kind, name, opts.scope),
      message: opts.entry.localReason,
      ...runtimeWarningFields(opts.project, kind, name),
    };
  }

  let before: string | null;
  try {
    before = await shaOfInstalledForScope(opts.project, kind, name, opts.scope);
  } catch (error) {
    if (!(error instanceof PreconditionError)) throw error;
    before = null;
  }
  let dataBeforeMatches = false;
  let reconciliationFiles: CopyDirectoryReconciliationFiles;
  if (opts.entry.source === "data") {
    if (!opts.dataRepo) {
      throw new Error(`data repo is required to apply ${kind}/${name}`);
    }
    assertCanMaterializeInstalled(opts.project, kind, name);
    reconciliationFiles = await copyDirectoryReconciliationFiles({
      project: opts.project,
      dataRepo: opts.dataRepo,
      manifest: opts.manifest,
      kind,
      name,
      entry: opts.entry,
      previousEntry: opts.previousEntry ?? opts.entry,
      scope: opts.scope,
      hooks: opts.hooks,
    });
  } else {
    const item = findSystemItem(name);
    if (!item || item.kind !== kind) {
      throw new Error(`system item no longer bundled: ${kind}/${name}`);
    }
    assertCanMaterializeInstalled(opts.project, kind, name);
    const sourceSha = await shaOfSystemItem(item);
    if (sourceSha !== opts.entry.sha) {
      throw new Error(
        `bundled ${kind}/${name} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
      );
    }
    reconciliationFiles = await copyDirectoryReconciliationFiles({
      project: opts.project,
      kind,
      name,
      entry: opts.entry,
      previousEntry: opts.previousEntry ?? opts.entry,
      scope: opts.scope,
      hooks: opts.hooks,
    });
  }

  dataBeforeMatches = await installedFilesMatch(
    dst,
    reconciliationFiles.expected,
    reconciliationFiles.preserved,
  );
  if (!opts.dryRun && !dataBeforeMatches) {
    await materializeCopyDirectory(
      opts.project,
      kind,
      name,
      reconciliationFiles,
      opts.hooks,
    );
  } else if (!opts.dryRun) {
    await ensureInstallAliases(opts.project, kind, name);
  }

  // The transactional writer verifies both selected managed bytes and copied-
  // forward local bytes. The reported sha remains the selected lock sha;
  // intentionally ignored local-only files are outside that content identity.
  //
  // `dataBeforeMatches` is the only convergence signal, deliberately: it byte-
  // compares every expected and preserved path. Comparing the Git-visible
  // installed sha against the lock sha instead would report permanent
  // `would-reconcile` for any item whose managed content includes paths the
  // project's own .gitignore hides, making --dry-run disagree with apply.
  const changed = !dataBeforeMatches;
  return {
    key: opts.key,
    source,
    kind,
    name,
    action: opts.dryRun
      ? changed
        ? "would-reconcile"
        : "already-current"
      : changed
        ? "reconciled"
        : "already-current",
    path: dst,
    sha: opts.dryRun ? before : opts.entry.sha,
    ...(opts.dryRun && {
      currentSha: before,
      plannedSha: opts.entry.sha,
      dryRun: true as const,
    }),
    ...runtimeWarningFields(opts.project, kind, name),
  };
}

export async function copyDirectoryReconciliationFiles(opts: {
  project: string;
  dataRepo?: string;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  entry: LockEntry;
  previousEntry: LockEntry;
  scope: Scope;
  hooks?: MaterializeHooks;
}): Promise<CopyDirectoryReconciliationFiles> {
  const expected = await filesForEntry(
    opts.dataRepo,
    opts.manifest,
    opts.kind,
    opts.name,
    opts.entry,
    opts.hooks,
  );
  const sourceSha = shaOfNamedFiles(expected);
  if (sourceSha !== opts.entry.sha) {
    const sourceLabel =
      opts.entry.source === "data"
        ? `${opts.kind}/${opts.name} at ${opts.entry.sourceCommit}`
        : `bundled ${opts.kind}/${opts.name}`;
    throw new Error(
      `source ${sourceLabel} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
    );
  }

  const dst = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(dst)) return { expected, preserved: [] };

  const previous = await filesForEntry(
    opts.dataRepo,
    opts.manifest,
    opts.kind,
    opts.name,
    opts.previousEntry,
  );
  const previousPaths = new Set(previous.map((file) => file.path));
  const snapshot = await installedSnapshot(
    opts.project,
    opts.kind,
    opts.name,
    opts.scope,
  );
  const visiblePaths = new Set(snapshot?.files ?? []);
  const inventory = await inventoryLocalTree(dst);
  const preserved: PreservedEntry[] = [];
  for (const path of inventory.files) {
    // Row 5: the sidecar is excluded from hashing and materialization
    // everywhere, so it is carried across regardless of Git visibility. Every
    // other Git-visible path is row 3 — drift the caller reconciles away.
    if (!isMetadataSidecarPath(path) && visiblePaths.has(path)) continue;
    if (previousPaths.has(path)) continue;
    const fullPath = join(dst, ...path.split("/"));
    const info = await lstat(fullPath);
    preserved.push({
      kind: "file",
      path,
      content: await readFile(fullPath),
      mode: info.mode & 0o7777,
    });
  }
  for (const object of inventory.irregular) {
    if (object.type !== "symlink") {
      throw new PreconditionError(
        `${dst} contains an unsupported filesystem object: ${object.path}; fifos, sockets, and device nodes cannot be recreated by a directory replacement`,
        {
          hint: `Remove or relocate the path, then rerun the command. \`${PRODUCT_NAME} rm\` can still delete the item with it in place.`,
        },
      );
    }
    const fullPath = join(dst, ...object.path.split("/"));
    preserved.push({
      kind: "symlink",
      path: object.path,
      target: await readlink(fullPath),
    });
  }

  for (const localFile of preserved) {
    const collision = expected.find((sourceFile) =>
      pathsCollide(localFile.path, sourceFile.path),
    );
    if (collision) {
      throw new PreconditionError(
        `ignored local path ${localFile.path} collides with selected managed path ${collision.path} in ${opts.kind}/${opts.name}`,
        {
          hint: "Move or rename the local-only path, then review the item and rerun the command.",
        },
      );
    }
  }

  return {
    expected,
    preserved: preserved.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

/**
 * The managed file set a lock entry selects, without touching the project.
 * Removal planning needs it to tell managed content apart from local state,
 * but must not depend on the reconciliation preflight: `rm` has to work when
 * the data repo is gone or the source commit was garbage-collected.
 */
export async function lockedCopyDirectoryFiles(opts: {
  dataRepo?: string;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  entry: LockEntry;
}): Promise<NamedFile[]> {
  return await filesForEntry(
    opts.dataRepo,
    opts.manifest,
    opts.kind,
    opts.name,
    opts.entry,
  );
}

async function readDataFilesAtCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  kind: CopyDirectoryItemKind,
  name: string,
  commit: string,
  hooks?: MaterializeHooks,
): Promise<NamedFile[]> {
  const repoRelPath = itemRepoRelPath(kind, name);
  const entries = await materializableFilesAtCommit(
    dataRepo,
    manifest,
    commit,
    repoRelPath,
  );
  const files: NamedFile[] = [];
  for (const [index, entry] of entries.entries()) {
    await hooks?.beforeSourceRead?.(entry.path, index);
    let content: Buffer;
    try {
      content = await showAtCommit(dataRepo, commit, entry.path);
    } catch {
      throwMissingCommit(dataRepo, manifest, commit);
    }
    files.push({
      path: posix.relative(repoRelPath, entry.path),
      content,
      mode: entry.mode === "100755" ? "100755" : "100644",
    });
  }
  return files;
}

async function materializeCopyDirectory(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  files: CopyDirectoryReconciliationFiles,
  hooks?: MaterializeHooks,
): Promise<void> {
  const dst = installedPath(project, kind, name);
  assertCanMaterializeInstalled(project, kind, name);
  const transaction = await beginDirectoryReplacement(dst, async (staged) => {
    for (const [index, file] of files.expected.entries()) {
      const out = join(staged, ...file.path.split("/"));
      await mkdir(dirname(out), { recursive: true });
      await hooks?.beforeStagedWrite?.(file.path, index);
      await writeFile(out, file.content);
      await hooks?.afterStagedWrite?.(file.path, index);
      const mode = fileModeFromGit(file.mode);
      await hooks?.beforeStagedChmod?.(file.path, index);
      await chmod(out, mode);
      await hooks?.afterStagedChmod?.(file.path, index);
    }
    for (const entry of files.preserved) {
      const out = join(staged, ...entry.path.split("/"));
      await mkdir(dirname(out), { recursive: true });
      if (entry.kind === "symlink") {
        await symlink(entry.target, out);
        continue;
      }
      await writeFile(out, entry.content);
      await chmod(out, entry.mode);
    }
    await hooks?.beforePublish?.();
  });
  try {
    await hooks?.afterPublish?.();
    if (!(await installedFilesMatch(dst, files.expected, files.preserved))) {
      throw new Error(
        `materialized ${kind}/${name} does not match the staged regular-file tree`,
      );
    }
    await ensureInstallAliases(project, kind, name);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function filesForEntry(
  dataRepo: string | undefined,
  manifest: Manifest | undefined,
  kind: CopyDirectoryItemKind,
  name: string,
  entry: LockEntry,
  hooks?: MaterializeHooks,
): Promise<NamedFile[]> {
  if (entry.source === "data") {
    if (!dataRepo)
      throw new Error(`data repo is required to apply ${kind}/${name}`);
    return await readDataFilesAtCommit(
      dataRepo,
      manifest,
      kind,
      name,
      entry.sourceCommit,
      hooks,
    );
  }
  const item = findSystemItem(name);
  if (!item || item.kind !== kind) {
    throw new Error(`system item no longer bundled: ${kind}/${name}`);
  }
  return item.files
    .map((file) => ({
      path: file.relPath,
      content: Buffer.from(file.content),
      mode: "100644" as const,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function materializableFilesAtCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  commit: string,
  repoRelPath: string,
): Promise<GitTreeEntry[]> {
  let entries: GitTreeEntry[];
  try {
    entries = await lsTreeEntriesAtCommit(dataRepo, commit, repoRelPath);
  } catch {
    throwMissingCommit(dataRepo, manifest, commit);
  }
  assertRegularBlobEntries(entries, repoRelPath);

  const files = entries
    .filter((file) => {
      const rel = posix.relative(repoRelPath, file.path);
      return (
        file.type === "blob" &&
        rel &&
        !rel.startsWith("..") &&
        !hasIgnoredDotSegment(rel) &&
        // The metadata sidecar is catalog data: apply/revert never copy it
        // into the project and the at-commit sha never includes it, keeping
        // both consistent with the working-tree sha.
        !isMetadataSidecarPath(rel)
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    throw new Error(`${repoRelPath} has no materializable files at ${commit}`);
  }

  return files;
}

function runtimeWarningFields(
  project: string,
  kind: ItemKind,
  name: string,
): Pick<MaterializeResult, "runtimeWarnings"> {
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
  return runtimeWarnings.length > 0 ? { runtimeWarnings } : {};
}

function throwMissingCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  commit: string,
): never {
  if (manifest) {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  throw new Error(`data repo at ${dataRepo} does not contain commit ${commit}`);
}

function fileModeFromGit(mode: string): number {
  switch (mode) {
    case "100644":
      return 0o644;
    case "100755":
      return 0o755;
    default:
      throw new Error(`unsupported regular-file mode: ${mode}`);
  }
}

async function installedFilesMatch(
  root: string,
  expected: NamedFile[],
  preserved: PreservedEntry[] = [],
): Promise<boolean> {
  if (!existsSync(root)) return false;
  const knownPaths = new Set([
    ...expected.map((file) => file.path),
    ...preserved.map((entry) => entry.path),
  ]);
  for (const path of await gitignoreVisibleFiles(root)) {
    // The sidecar is catalog data, never managed content and never drift.
    if (isMetadataSidecarPath(path)) continue;
    if (!knownPaths.has(path)) return false;
  }
  const current: NamedFile[] = [];
  for (const file of expected) {
    const fullPath = join(root, ...file.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null || !stats.isFile()) return false;
    current.push({
      path: file.path,
      content: await readFile(fullPath),
      mode: (stats.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }
  if (!namedFilesEqual(current, expected)) return false;

  for (const entry of preserved) {
    const fullPath = join(root, ...entry.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null) return false;
    if (entry.kind === "symlink") {
      if (!stats.isSymbolicLink()) return false;
      if ((await readlink(fullPath)) !== entry.target) return false;
      continue;
    }
    if (!stats.isFile()) return false;
    if ((stats.mode & 0o7777) !== entry.mode) return false;
    if (!(await readFile(fullPath)).equals(entry.content)) return false;
  }
  return true;
}

async function lstatOrNullAsync(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function pathsCollide(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
