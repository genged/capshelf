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
  shaOfItem,
} from "./master";
import type { CopyDirectoryItemKind } from "./master";
import { shaOfInstalledForScope } from "./item-snapshot";
import type { Scope } from "./promote-core";
import { findSystemItem, installSystemItem, shaOfSystemItem } from "./bundled";
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
import { gitignoreVisibleFiles } from "./gitignore";
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
  if (opts.entry.source === "data") {
    if (!opts.dataRepo) {
      throw new Error(`data repo is required to apply ${kind}/${name}`);
    }
    assertCanMaterializeInstalled(opts.project, kind, name);
    if (opts.dryRun) {
      const sourceFiles = await readDataFilesAtCommit(
        opts.dataRepo,
        opts.manifest,
        kind,
        name,
        opts.entry.sourceCommit,
        opts.hooks,
      );
      const sourceSha = shaOfNamedFiles(sourceFiles);
      if (sourceSha !== opts.entry.sha) {
        throw new Error(
          `source ${kind}/${name} at ${opts.entry.sourceCommit} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
        );
      }
      dataBeforeMatches = await installedFilesMatch(dst, sourceFiles);
    } else {
      dataBeforeMatches = await materializeDataAtCommit(
        opts.project,
        opts.dataRepo,
        opts.manifest,
        kind,
        name,
        opts.entry.sourceCommit,
        opts.entry.sha,
        opts.hooks,
      );
    }
  } else {
    const item = findSystemItem(name);
    if (!item || item.kind !== kind) {
      throw new Error(`system item no longer bundled: ${kind}/${name}`);
    }
    if (opts.dryRun) {
      assertCanMaterializeInstalled(opts.project, kind, name);
      const sourceSha = await shaOfSystemItem(item);
      if (sourceSha !== opts.entry.sha) {
        throw new Error(
          `bundled ${kind}/${name} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
        );
      }
    } else {
      await installSystemItem(opts.project, item);
    }
  }

  // Post-write verification hashes the just-replaced directory directly: the
  // materializer owns it and populated it from the expected source file set,
  // so destination Git ignore policy (project .gitignore, .git/info/exclude,
  // global excludes) must not decide whether the written bytes count.
  const after = opts.dryRun ? before : await shaOfItem(dst);
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

  const changed =
    opts.entry.source === "data" ? !dataBeforeMatches : before !== after;
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

async function materializeDataAtCommit(
  project: string,
  dataRepo: string,
  manifest: Manifest | undefined,
  kind: CopyDirectoryItemKind,
  name: string,
  commit: string,
  expectedSha: string,
  hooks?: MaterializeHooks,
): Promise<boolean> {
  const repoRelPath = itemRepoRelPath(kind, name);
  const entries = await materializableFilesAtCommit(
    dataRepo,
    manifest,
    commit,
    repoRelPath,
  );

  const dst = installedPath(project, kind, name);
  assertCanMaterializeInstalled(project, kind, name);
  let sourceFiles: NamedFile[] = [];
  let beforeMatches = false;
  const transaction = await beginDirectoryReplacement(dst, async (staged) => {
    sourceFiles = [];
    for (const [index, entry] of entries.entries()) {
      await hooks?.beforeSourceRead?.(entry.path, index);
      let content: Buffer;
      try {
        content = await showAtCommit(dataRepo, commit, entry.path);
      } catch {
        throwMissingCommit(dataRepo, manifest, commit);
      }
      const rel = posix.relative(repoRelPath, entry.path);
      const out = join(staged, ...rel.split("/"));
      await mkdir(dirname(out), { recursive: true });
      await hooks?.beforeStagedWrite?.(entry.path, index);
      await writeFile(out, content);
      await hooks?.afterStagedWrite?.(entry.path, index);
      const mode = fileModeFromGit(entry.mode);
      await hooks?.beforeStagedChmod?.(entry.path, index);
      await chmod(out, mode);
      await hooks?.afterStagedChmod?.(entry.path, index);
      sourceFiles.push({
        path: rel,
        content,
        mode: entry.mode === "100755" ? "100755" : "100644",
      });
    }
    const sourceSha = shaOfNamedFiles(sourceFiles);
    if (sourceSha !== expectedSha) {
      throw new Error(
        `source ${kind}/${name} at ${commit} hashes to ${sourceSha}, but lock expects ${expectedSha}`,
      );
    }
    beforeMatches = await installedFilesMatch(dst, sourceFiles);
    await hooks?.beforePublish?.();
  });
  try {
    await hooks?.afterPublish?.();
    if (!(await installedFilesMatch(dst, sourceFiles))) {
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
  return beforeMatches;
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
): Promise<boolean> {
  if (!existsSync(root)) return false;
  const paths = new Set(
    (await gitignoreVisibleFiles(root)).filter(
      (path) => !isMetadataSidecarPath(path),
    ),
  );
  for (const file of expected) paths.add(file.path);
  const current: NamedFile[] = [];
  for (const path of [...paths].sort()) {
    const fullPath = join(root, ...path.split("/"));
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stats.isFile()) return false;
    current.push({
      path,
      content: await readFile(fullPath),
      mode: (stats.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }
  return namedFilesEqual(current, expected);
}
