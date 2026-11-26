import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { entryIdentity } from "./lock";
import type { DataLockEntry, LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  parseLockKey,
  installedPath,
} from "./installed";
import type { ItemSource } from "./installed";
import { isTreePinned } from "./install-identity";
import { gitTreeSource, isGitTree, sameContentSource } from "./item-source";
import type { ContentSource, GitTreeSource } from "./item-source";
import type { GitReadMemo } from "./git-read-memo";
import type {
  CopyDirectoryItemKind,
  FragmentItemKind,
  ItemKind,
} from "./master";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
} from "./master";
import { hashNamedContents } from "./content-hash";
import type { Scope } from "./promote-core";
import { findSystemItem, shaOfSystemItem } from "./bundled";
import {
  abbreviatePin,
  hashWidthOf,
  installedPinDigest,
  itemTreeEntriesAtCommit,
  readEntryBytes,
  sourcePinDigest,
  targetsUnderRoot,
} from "./pin";
import type { PinTreeEntry } from "./pin";
import { runtimeWarningsForItem } from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import { missingSourceCommitMessage } from "./upstream-check";
import type { NamedFile } from "./merge-tree";
import { namedFilesEqual } from "./merge-tree";
import { inventoryLocalTree } from "./gitignore";
import { installedVisiblePaths } from "./installed-visibility";
import { beginDirectoryReplacement } from "./promote-transaction";
import {
  assertNoManagedPathOnMount,
  carriedUnits,
  isOnMount,
  readMountLayout,
} from "./mount-points";
import { marksPluginManifest } from "./plugin-runs";
import { shaOfNamedFiles } from "./item-snapshot";
import { PRODUCT_NAME } from "./identity";
import { PreconditionError } from "./errors";
import { assertSafeItemName } from "./assert";
import { isErrno } from "./fs-utils";
import { findDestinationPathCollision } from "./path-collision";
import { legacyShaAtCommit } from "./lock-verify";

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

/**
 * Entry and source travel together so a caller cannot pair one entry with
 * another entry's source.
 */
export interface SourcedEntry {
  entry: LockEntry;
  source: ContentSource;
}

export interface MaterializeOptions {
  project: string;
  source: ContentSource;
  manifest?: Manifest;
  kind: ItemKind;
  name: string;
  key: string;
  entry: LockEntry;
  previous?: SourcedEntry;
  /**
   * Lock scope the entry came from. It is not inferable from `entry.local`,
   * which records intentional divergence. Local-scope installs are
   * Git-excluded, so their current-state hashing must not consult project Git
   * visibility.
   */
  scope: Scope;
  ignoreLocal?: boolean;
  dryRun?: boolean;
  hooks?: MaterializeHooks;
  memo?: GitReadMemo;
}

/**
 * Not `NamedFile`: these paths never cross a Git boundary, so they keep real
 * `stat` modes and symlinks are recreated by target rather than refused.
 */
export type PreservedEntry =
  | {
      kind: "file";
      path: string;
      content?: Buffer;
    }
  | { kind: "symlink"; path: string; target: string };

export interface CopyDirectoryReconciliationFiles {
  expected: NamedFile[];
  preserved: PreservedEntry[];
  entries: readonly PinTreeEntry[];
}

export async function materializeLockEntry(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  // The name check follows the caller-supplied item, since `parseLockKey`
  // validates the key but no longer sees the name reaching `installedPath`.
  const { source: keySource } = parseLockKey(opts.key);
  const { kind, name } = opts;
  assertSafeItemName(name, `${kind} item`);
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

  if (opts.entry.source !== keySource) {
    throw new Error(
      `lock key ${opts.key} source does not match entry source ${opts.entry.source}`,
    );
  }

  const previous: SourcedEntry = opts.previous ?? {
    entry: opts.entry,
    source: opts.source,
  };

  if (
    opts.entry.source === "data" &&
    opts.entry.local === true &&
    !opts.ignoreLocal
  ) {
    return {
      key: opts.key,
      source: keySource,
      kind,
      name,
      action: "kept-local",
      path: dst,
      sha: await installedIdentityForEntry(
        dst,
        opts.entry,
        await itemContentForSource(
          opts.source,
          kind,
          name,
          opts.manifest,
          undefined,
          opts.memo,
        ).catch(() => null),
      ),
      message: opts.entry.localReason,
      ...runtimeWarningFields(opts.project, kind, name),
    };
  }

  if (isGitTree(opts.source)) {
    assertCanMaterializeInstalled(opts.project, kind, name);
  } else {
    const item = findSystemItem(name);
    if (!item || item.kind !== kind) {
      throw new Error(`system item no longer bundled: ${kind}/${name}`);
    }
    assertCanMaterializeInstalled(opts.project, kind, name);
    // Superseded bundled content is unrecoverable, so retrying cannot fix this;
    // report the state and name the command that re-pins it.
    const sourceSha = await shaOfSystemItem(item);
    if (sourceSha !== opts.source.sha) {
      throw new Error(
        `bundled ${kind}/${name} in this ${PRODUCT_NAME} binary hashes to ${sourceSha}, but lock expects ${opts.source.sha}; superseded bundled content is not recoverable — run \`${PRODUCT_NAME} update ${kind}/${name}\` to re-pin the item to the bundled content this binary carries`,
      );
    }
  }
  const reconciliationFiles = await copyDirectoryReconciliationFiles({
    project: opts.project,
    source: opts.source,
    manifest: opts.manifest,
    kind,
    name,
    entry: opts.entry,
    previous,
    scope: opts.scope,
    hooks: opts.hooks,
    memo: opts.memo,
  });

  // Identity is computed from the filesystem over the managed path set, not
  // project Git, so `.gitignore` edits and `--local` excludes can't change it;
  // it is named in the previous entry's model so an upstream content change
  // doesn't look like drift.
  const before = await installedIdentityForEntry(
    dst,
    previous.entry,
    previous.entry === opts.entry
      ? {
          entries: reconciliationFiles.entries,
          files: reconciliationFiles.expected,
        }
      : await itemContentForSource(
          previous.source,
          kind,
          name,
          opts.manifest,
          undefined,
          opts.memo,
        ).catch(() => null),
  );
  const dataBeforeMatches = await installedFilesMatch({
    project: opts.project,
    kind,
    name,
    scope: opts.scope,
    root: dst,
    expected: reconciliationFiles.expected,
    preserved: reconciliationFiles.preserved,
  });
  if (!opts.dryRun && !dataBeforeMatches) {
    await materializeCopyDirectory(
      opts.project,
      kind,
      name,
      opts.scope,
      reconciliationFiles,
      opts.hooks,
    );
  } else if (!opts.dryRun) {
    await ensureInstallAliases(opts.project, kind, name);
  }

  // Preserved files move by rename, so convergence checks their types and
  // symlink targets rather than their bytes. Managed bytes and modes are
  // compared directly so project ignore rules cannot make dry-run disagree
  // with apply.
  const changed = !dataBeforeMatches;
  return {
    key: opts.key,
    source: keySource,
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
    sha: opts.dryRun ? before : entryIdentity(opts.entry),
    ...(opts.dryRun && {
      currentSha: before,
      plannedSha: entryIdentity(opts.entry),
      dryRun: true as const,
    }),
    ...runtimeWarningFields(opts.project, kind, name),
  };
}

async function installedIdentityForEntry(
  root: string,
  entry: LockEntry,
  content: { entries: readonly PinTreeEntry[]; files: NamedFile[] } | null,
): Promise<string | null> {
  if (content === null || !existsSync(root)) return null;
  if (isTreePinned(entry)) {
    return await installedPinDigest(
      targetsUnderRoot(root, content.entries),
      hashWidthOf(content.entries),
    );
  }
  const present: Array<{ name: string; content: Buffer }> = [];
  for (const file of content.files) {
    const fullPath = join(root, ...file.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null || !stats.isFile()) continue;
    present.push({ name: file.path, content: await readFile(fullPath) });
  }
  return hashNamedContents(present);
}

export async function copyDirectoryReconciliationFiles(opts: {
  project: string;
  source: ContentSource;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  entry: LockEntry;
  previous: SourcedEntry;
  scope: Scope;
  hooks?: MaterializeHooks;
  memo?: GitReadMemo;
}): Promise<CopyDirectoryReconciliationFiles> {
  const content = await itemContentForSource(
    opts.source,
    opts.kind,
    opts.name,
    opts.manifest,
    opts.hooks,
    opts.memo,
  );
  const expected = content.files;
  // System entries are not verified here: `filesForEntry` returns the running
  // binary's bundled tree regardless of the entry, so comparing it to
  // `entry.sha` checks no retrieval; `materializeLockEntry` enforces that
  // policy before any write.
  if (isGitTree(opts.source) && opts.entry.source === "data") {
    assertSourceMatchesEntry(
      opts.kind,
      opts.name,
      opts.entry,
      content.entries,
      expected,
    );
  }

  const dst = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(dst)) {
    return { expected, preserved: [], entries: content.entries };
  }

  // The previous entry only names which installed paths were managed before, so
  // ignored local state can be told apart from stale managed content. An
  // unresolvable previous pin therefore degrades to 'nothing was managed
  // before' and does not block the command replacing it. A stale managed path
  // that the project ignores is preserved, not deleted. Every Git-visible one
  // still reaches the consent boundary.
  const previous = sameContentSource(opts.source, opts.previous.source)
    ? expected
    : await itemContentForSource(
        opts.previous.source,
        opts.kind,
        opts.name,
        opts.manifest,
        undefined,
        opts.memo,
      ).then(
        (content) => content.files,
        () => [],
      );
  const previousPaths = new Set(previous.map((file) => file.path));
  // Pinned paths are always managed, since an ignore rule cannot hide them, so
  // only extras are classified as possibly user-owned.
  const managedPaths = new Set([
    ...expected.map((file) => file.path),
    ...previousPaths,
  ]);
  const classified = await classifyInstalledEntries({
    project: opts.project,
    dst,
    kind: opts.kind,
    name: opts.name,
    managedPaths,
    scope: opts.scope,
    incoming: expected,
  });
  const preserved = classified.preserved;
  await assertNothingToDeleteOnMount({
    dst,
    installedPaths: classified.installedPaths,
    expected,
    preserved,
  });

  await assertNoPreservedPathCollisions({
    destination: dst,
    preserved,
    expected,
    kind: opts.kind,
    name: opts.name,
  });

  return {
    expected,
    entries: content.entries,
    preserved: preserved.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

/**
 * Refuses a fifo, socket, or device node because a directory replacement cannot
 * put one back.
 */
export async function preservedLocalEntries(opts: {
  project: string;
  dst: string;
  kind: CopyDirectoryItemKind;
  name: string;
  managedPaths: ReadonlySet<string>;
  scope: Scope;
  readContent?: boolean;
}): Promise<PreservedEntry[]> {
  return (await classifyInstalledEntries(opts)).preserved;
}

async function classifyInstalledEntries(opts: {
  project: string;
  dst: string;
  kind: CopyDirectoryItemKind;
  name: string;
  managedPaths: ReadonlySet<string>;
  scope: Scope;
  readContent?: boolean;
  incoming?: readonly NamedFile[];
}): Promise<{ preserved: PreservedEntry[]; installedPaths: string[] }> {
  const inventory = await inventoryLocalTree(opts.dst);
  const installedPaths = [
    ...inventory.files,
    ...inventory.irregular.map((object) => object.path),
  ];
  const extras = installedPaths.filter((path) => !opts.managedPaths.has(path));
  const visibleExtras = await installedVisiblePaths({
    project: opts.project,
    root: opts.dst,
    kind: opts.kind,
    name: opts.name,
    candidates: extras,
    scope: opts.scope,
    ...(opts.incoming !== undefined && { incoming: opts.incoming }),
  });
  const preserved: PreservedEntry[] = [];
  for (const path of inventory.files) {
    // Row 5: the sidecar is excluded from hashing and materialization
    // everywhere, so it is carried across regardless of Git visibility. Every
    // other Git-visible extra is row 3 drift, which the caller reconciles away.
    if (!isMetadataSidecarPath(path) && visibleExtras.has(path)) continue;
    if (opts.managedPaths.has(path)) continue;
    preserved.push({
      kind: "file",
      path,
      ...(opts.readContent === true && {
        content: await readFile(join(opts.dst, ...path.split("/"))),
      }),
    });
  }
  for (const object of inventory.irregular) {
    // Non-recreatable objects are refused regardless of ignore status: a
    // replacement cannot restore them and consent cannot authorize silent
    // deletion.
    if (object.type !== "symlink") {
      throw new PreconditionError(
        `${opts.dst} contains an unsupported filesystem object: ${object.path}; fifos, sockets, and device nodes cannot be recreated by a directory replacement`,
        {
          hint: `Remove or relocate the path, then rerun the command. \`${PRODUCT_NAME} rm\` can still delete the item with it in place.`,
        },
      );
    }
    // A Git-visible symlink is owned by the project's own policy, so
    // reconciliation removes it instead of carrying it across.
    if (visibleExtras.has(object.path)) continue;
    if (opts.managedPaths.has(object.path)) continue;
    const fullPath = join(opts.dst, ...object.path.split("/"));
    preserved.push({
      kind: "symlink",
      path: object.path,
      target: await readlink(fullPath),
    });
  }

  return { preserved, installedPaths };
}

/**
 * A replacement around a mount cannot delete a path on the mounted volume. So a
 * path there that the write would delete refuses before consent: a Git-visible
 * extra, or a path the previous version managed. A managed path that the new
 * version writes there refuses too.
 */
async function assertNothingToDeleteOnMount(opts: {
  dst: string;
  installedPaths: readonly string[];
  expected: readonly NamedFile[];
  preserved: readonly PreservedEntry[];
}): Promise<void> {
  const layout = await readMountLayout(opts.dst);
  if (layout.mounts.size === 0) return;
  await assertNoManagedPathOnMount(
    opts.dst,
    layout,
    opts.expected.map((file) => file.path),
  );
  const kept = new Set(opts.preserved.map((entry) => entry.path));
  const doomed = opts.installedPaths.find(
    (path) => isOnMount(layout, path) && !kept.has(path),
  );
  if (doomed === undefined) return;
  const [mount] = [...layout.mounts].filter((candidate) =>
    isOnMount({ mounts: new Set([candidate]), pinned: new Set() }, doomed),
  );
  throw new PreconditionError(
    `${doomed} in ${opts.dst} is on mounted volume ${mount ?? doomed}, and Git can see it; ${PRODUCT_NAME} cannot delete a path on a mounted volume`,
    {
      hint: `Ignore ${mount ?? doomed}/ in the item's .gitignore, then rerun the command.`,
    },
  );
}

export async function installedPreservedEntries(opts: {
  project: string;
  kind: CopyDirectoryItemKind;
  name: string;
  scope: Scope;
  managedPaths: ReadonlySet<string>;
}): Promise<PreservedEntry[]> {
  const dst = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(dst)) return [];
  const entries = await preservedLocalEntries({ ...opts, dst });
  // Kept-file bytes are read only for a plugin, or for an item with a plugin
  // manifest path. A skill with no manifest path anywhere is not one, so its
  // ignored state (e.g. node_modules) is not read.
  const mayBePlugin =
    opts.kind === "plugins" ||
    [...opts.managedPaths, ...entries.map((entry) => entry.path)].some((path) =>
      marksPluginManifest(path, false),
    );
  if (!mayBePlugin) return entries;
  return await Promise.all(
    entries.map(async (entry) =>
      entry.kind === "file"
        ? {
            ...entry,
            content: await readFile(join(dst, ...entry.path.split("/"))),
          }
        : entry,
    ),
  );
}

export async function assertNoPreservedPathCollisions(opts: {
  destination: string;
  preserved: readonly PreservedEntry[];
  expected: readonly NamedFile[];
  kind: CopyDirectoryItemKind;
  name: string;
}): Promise<void> {
  const collision = await findDestinationPathCollision(
    opts.destination,
    opts.preserved.map((entry) => entry.path),
    opts.expected.map((file) => file.path),
  );
  if (!collision) return;
  throw new PreconditionError(
    `ignored local path ${collision.left} collides with selected managed path ${collision.right} in ${opts.kind}/${opts.name}`,
    {
      hint: "Move or rename the local-only path, then review the item and rerun the command.",
    },
  );
}

/**
 * The managed file set a lock entry selects, without touching the project.
 * Removal planning needs it to tell managed content from local state. It must
 * not depend on the reconciliation preflight, because `rm` has to work when the
 * data repo is gone or the source commit was garbage-collected.
 */
export async function lockedCopyDirectoryFiles(opts: {
  source: ContentSource;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
}): Promise<NamedFile[]> {
  return (
    await itemContentForSource(opts.source, opts.kind, opts.name, opts.manifest)
  ).files;
}

/**
 * Memoized per process because a commit's tree is immutable; the local
 * filesystem is deliberately not cached since revalidation must see changes.
 */
const atCommitFiles = new Map<string, CommitItemContent>();

async function _readDataFilesAtCommit(
  source: GitTreeSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
): Promise<NamedFile[]> {
  return (await readItemContentAtCommit(source, kind, name, manifest, hooks))
    .files;
}

interface CommitItemContent {
  entries: PinTreeEntry[];
  files: NamedFile[];
}

/**
 * `cat-file` applies no smudge filter, so installed bytes are exactly what the
 * commit holds, identical for `add` and `apply`.
 */
async function readItemContentAtCommit(
  source: GitTreeSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
  memo?: GitReadMemo,
): Promise<CommitItemContent> {
  const cacheKey = `${source.repo}\0${source.commit}\0${source.itemRoot}`;
  const cached = atCommitFiles.get(cacheKey);
  if (cached) {
    // Hooks still fire on cache hits because transaction tests inject failures
    // through them, and a cached pass must behave like a cold one.
    for (const [index, entry] of cached.entries.entries()) {
      await hooks?.beforeSourceRead?.(entry.repoRelPath, index);
    }
    // Return a fresh array per caller so in-place sorting by one caller cannot
    // reorder another's.
    return { entries: [...cached.entries], files: [...cached.files] };
  }

  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(source, kind, memo);
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throwMissingCommit(source.repo, manifest, source.commit, { kind, name });
  }
  if (entries.length === 0) {
    throw new Error(
      `${source.itemRoot} has no materializable files at ${source.commit}`,
    );
  }
  for (const [index, entry] of entries.entries()) {
    await hooks?.beforeSourceRead?.(entry.repoRelPath, index);
  }
  let files: NamedFile[];
  try {
    files = (await readEntryBytes(source.repo, entries, memo)).map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.mode,
    }));
  } catch {
    throwMissingCommit(source.repo, manifest, source.commit, { kind, name });
  }
  const content: CommitItemContent = { entries, files };
  atCommitFiles.set(cacheKey, content);
  return { entries: [...entries], files: [...files] };
}

/**
 * v4 compares the committed tree's `sourcePinDigest` so no working-tree state
 * can affect it; v3 keeps the legacy hash so projects that haven't run `lock
 * migrate` can still apply.
 */
function assertSourceMatchesEntry(
  kind: CopyDirectoryItemKind,
  name: string,
  entry: DataLockEntry,
  entries: readonly PinTreeEntry[],
  expected: NamedFile[],
): void {
  if (entry.sourcePinDigest !== undefined) {
    const digest = sourcePinDigest(entries);
    if (digest === entry.sourcePinDigest) return;
    throw new Error(
      `source ${kind}/${name} at ${entry.sourceCommit} pins to ${abbreviatePin(digest)}, but lock expects ${abbreviatePin(entry.sourcePinDigest)}\n` +
        `  ${unprovablePinGuidance(kind, name)}`,
    );
  }
  const sourceSha = shaOfNamedFiles(expected);
  if (sourceSha === entry.sha) return;
  throw new Error(
    `source ${kind}/${name} at ${entry.sourceCommit} hashes to ${sourceSha}, but lock expects ${entry.sha}\n` +
      `  ${unprovablePinGuidance(kind, name)}`,
  );
}

/**
 * The fragment form of `assertSourceMatchesEntry`, for `apply` and `revert`.
 *
 * A fragment has no copy step, so no read inside the reconciler compares the
 * tree at `entry.sourceCommit` with the lock. `apply` and `revert` call this
 * before they plan any output, so a contradictory pin refuses the item with
 * the skill message and nothing is written. `update` does not call it: it is
 * the repair.
 */
export async function assertFragmentEntryMatchesLock(opts: {
  dataRepo: string;
  manifest: Manifest;
  kind: FragmentItemKind;
  name: string;
  entry: DataLockEntry;
  memo?: GitReadMemo;
}): Promise<void> {
  const { dataRepo, manifest, kind, name, entry, memo } = opts;
  if (entry.sourcePinDigest !== undefined) {
    const digest = sourcePinDigest(
      await itemTreeEntriesAtCommit(
        gitTreeSource({
          repo: dataRepo,
          kind,
          name,
          commit: entry.sourceCommit,
        }),
        kind,
        memo,
      ).catch(() => {
        throw new Error(
          `${missingSourceCommitMessage(dataRepo, entry.sourceCommit, manifest)}\n  ${unprovablePinGuidance(kind, name)}`,
        );
      }),
    );
    if (digest === entry.sourcePinDigest) return;
    throw new Error(
      `source ${kind}/${name} at ${entry.sourceCommit} pins to ${abbreviatePin(digest)}, but lock expects ${abbreviatePin(entry.sourcePinDigest)}\n` +
        `  ${unprovablePinGuidance(kind, name)}`,
    );
  }
  const sourceSha = await legacyShaAtCommit(
    dataRepo,
    manifest,
    kind,
    name,
    entry.sourceCommit,
  );
  if (sourceSha === entry.sha) return;
  throw new Error(
    `source ${kind}/${name} at ${entry.sourceCommit} hashes to ${sourceSha}, but lock expects ${entry.sha}\n` +
      `  ${unprovablePinGuidance(kind, name)}`,
  );
}

async function materializeCopyDirectory(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  scope: Scope,
  files: CopyDirectoryReconciliationFiles,
  hooks?: MaterializeHooks,
): Promise<void> {
  const dst = installedPath(project, kind, name);
  assertCanMaterializeInstalled(project, kind, name);
  const transaction = await beginDirectoryReplacement(
    dst,
    { root: project },
    async (staged, layout) => {
      const expectedPaths = files.expected.map((file) => file.path);
      await assertNoManagedPathOnMount(dst, layout, expectedPaths);
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
      // A folder with nothing managed, visible, or mounted is moved whole by
      // rename, so its bytes are never read.
      const inventory = existsSync(dst)
        ? await inventoryLocalTree(dst)
        : { files: [], irregular: [] };
      const installed = [
        ...inventory.files,
        ...inventory.irregular.map((object) => object.path),
      ];
      const present = new Set(installed);
      const keptPaths = files.preserved
        .map((entry) => entry.path)
        .filter((path) => present.has(path));
      const kept = new Set(keptPaths);
      const units = carriedUnits({
        kept: keptPaths,
        blockers: [
          ...expectedPaths,
          ...installed.filter((path) => !kept.has(path)),
        ],
        layout,
      });
      const collision = await findDestinationPathCollision(
        dst,
        units,
        expectedPaths,
      );
      if (collision) {
        throw new PreconditionError(
          `ignored local path ${collision.left} collides with selected managed path ${collision.right} in ${kind}/${name}`,
          {
            hint: "Move or rename the local-only path, then review the item and rerun the command.",
          },
        );
      }
      await hooks?.beforePublish?.();
      return units;
    },
  );
  try {
    await hooks?.afterPublish?.();
    if (
      !(await installedFilesMatch({
        project,
        kind,
        name,
        scope,
        root: dst,
        expected: files.expected,
        preserved: files.preserved,
      }))
    ) {
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

async function itemContentForSource(
  source: ContentSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
  memo?: GitReadMemo,
): Promise<CommitItemContent> {
  if (isGitTree(source)) {
    return await readItemContentAtCommit(
      source,
      kind,
      name,
      manifest,
      hooks,
      memo,
    );
  }
  const item = findSystemItem(name);
  if (!item || item.kind !== kind) {
    throw new Error(`system item no longer bundled: ${kind}/${name}`);
  }
  return {
    entries: [],
    files: item.files
      .map((file) => ({
        path: file.relPath,
        content: Buffer.from(file.content),
        mode: "100644" as const,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
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
  item?: { kind: CopyDirectoryItemKind; name: string },
): never {
  const detail = manifest
    ? missingSourceCommitMessage(dataRepo, commit, manifest)
    : `data repo at ${dataRepo} does not contain commit ${commit}`;
  throw new Error(
    item
      ? `${detail}\n  ${unprovablePinGuidance(item.kind, item.name)}`
      : detail,
  );
}

/**
 * `apply` and `revert` target the locked commit and cannot repair an unprovable
 * pin, since consent cannot create missing bytes; `update` selects a new
 * verified commit and can.
 */
function unprovablePinGuidance(
  kind: CopyDirectoryItemKind | FragmentItemKind,
  name: string,
): string {
  return `the locked source cannot supply a verified target — repair the pin with: ${PRODUCT_NAME} update ${kind}/${name}`;
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

async function installedFilesMatch(opts: {
  project: string;
  kind: CopyDirectoryItemKind;
  name: string;
  scope: Scope;
  root: string;
  expected: NamedFile[];
  preserved?: readonly PreservedEntry[];
}): Promise<boolean> {
  const { root, expected } = opts;
  const preserved = opts.preserved ?? [];
  if (!existsSync(root)) return false;
  const knownPaths = new Set([
    ...expected.map((file) => file.path),
    ...preserved.map((entry) => entry.path),
  ]);
  const inventory = await inventoryLocalTree(root);
  const unknown = [
    ...inventory.files,
    ...inventory.irregular.map((object) => object.path),
  ].filter((path) => !knownPaths.has(path) && !isMetadataSidecarPath(path));
  const visibleUnknown = await installedVisiblePaths({
    project: opts.project,
    root,
    kind: opts.kind,
    name: opts.name,
    candidates: unknown,
    scope: opts.scope,
    incoming: expected,
  });
  if (visibleUnknown.size > 0) return false;
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

  // Row 4 moves by rename, which keeps the bytes, so a byte compare proves
  // nothing. A kept path must keep its type, and a symlink must keep its
  // target. A folder at the path fails the check. One the user deleted is gone.
  // The walk above already read each type, so a kept path needs no lstat of its
  // own: an ignored tree can hold many thousands of files.
  const types = new Map<string, string>([
    ...inventory.files.map((path): [string, string] => [path, "file"]),
    ...inventory.irregular.map((object): [string, string] => [
      object.path,
      object.type,
    ]),
  ]);
  for (const entry of preserved) {
    const fullPath = join(root, ...entry.path.split("/"));
    const type = types.get(entry.path);
    if (type === undefined) {
      if ((await lstatOrNullAsync(fullPath))?.isDirectory() === true) {
        return false;
      }
      continue;
    }
    if (type !== entry.kind) return false;
    if (entry.kind === "symlink" && (await readlink(fullPath)) !== entry.target)
      return false;
  }
  return true;
}

async function lstatOrNullAsync(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}
