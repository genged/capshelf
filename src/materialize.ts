import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { existsSync } from "node:fs";
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
import { allRegularFiles, gitignoreVisibleFiles } from "./gitignore";
import { beginDirectoryReplacement } from "./promote-transaction";
import { shaOfNamedFiles } from "./item-snapshot";
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

export interface CopyDirectoryReconciliationFiles {
  expected: NamedFile[];
  preserved: NamedFile[];
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
  const after = opts.dryRun ? before : opts.entry.sha;
  if (after !== opts.entry.sha) {
    if (opts.dryRun) {
      return {
        key: opts.key,
        source,
        kind,
        name,
        action: "would-reconcile",
        path: dst,
        sha: before,
        currentSha: before,
        plannedSha: opts.entry.sha,
        dryRun: true,
        ...runtimeWarningFields(opts.project, kind, name),
      };
    }
    throw new Error(
      `materialized ${kind}/${name} at ${after ?? "(missing)"}, but lock expects ${opts.entry.sha}`,
    );
  }

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
    sha: after,
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
  const preserved: NamedFile[] = [];
  for (const path of await allRegularFiles(dst)) {
    if (visiblePaths.has(path) || previousPaths.has(path)) continue;
    const fullPath = join(dst, ...path.split("/"));
    const info = await lstat(fullPath);
    preserved.push({
      path,
      content: await readFile(fullPath),
      mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
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
    for (const file of files.preserved) {
      const out = join(staged, ...file.path.split("/"));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, file.content);
      await chmod(out, fileModeFromGit(file.mode));
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
  preserved: NamedFile[] = [],
): Promise<boolean> {
  if (!existsSync(root)) return false;
  const known = [...expected, ...preserved].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const knownPaths = new Set(known.map((file) => file.path));
  for (const path of await gitignoreVisibleFiles(root)) {
    if (isMetadataSidecarPath(path)) return false;
    if (!knownPaths.has(path)) return false;
  }
  const current: NamedFile[] = [];
  for (const file of known) {
    const fullPath = join(root, ...file.path.split("/"));
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stats.isFile()) return false;
    current.push({
      path: file.path,
      content: await readFile(fullPath),
      mode: (stats.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }
  return namedFilesEqual(current, known);
}

function pathsCollide(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}
