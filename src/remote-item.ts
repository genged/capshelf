/**
 * Pin, install, and reconcile one pulled skill.
 *
 * A remote row reuses the copy-directory machinery rather than growing a second
 * reconciler. `materializeLockEntry` and `copyDirectoryReconciliationFiles`
 * hold the five-population object model, the preserved-versus-extra
 * classification, and the transactional write; a second implementation would be
 * a second object model that has to agree with the first.
 *
 * The content half needs nothing new: a remote row hands those functions a
 * `ContentSource` naming the cache clone, the commit, and the subpath, which is
 * the value they already take. The identity half is still synthetic —
 * `materializeLockEntry` verifies what it read against a digest that lives on a
 * `LockEntry` — so this module builds an in-memory `DataLockEntryV4` carrying
 * the remote row's digest. That value is never serialized: no writer puts it in
 * a `Lock`.
 */
import { PreconditionError } from "./errors";
import { PRODUCT_NAME } from "./identity";
import { installedPath } from "./installed";
import { dataKey } from "./lock";
import type { DataLockEntryV4 } from "./lock";
import { materializeLockEntry } from "./materialize";
import type { MaterializeResult } from "./materialize";
import {
  installedSnapshot,
  namedFilesFromInstalledSnapshot,
} from "./item-snapshot";
import { mergeNamedTrees, namedFilesEqual } from "./merge-tree";
import type { NamedFile } from "./merge-tree";
import { beginInstalledReconciliation } from "./promote-transaction";
import {
  remoteCachePath,
  remoteCacheState,
  resolveCachedRef,
} from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { REMOTE_ITEM_KIND, remoteKey } from "./remotes-lock";
import type { RemoteLockEntry } from "./remotes-lock";
import {
  assertNoDestinationCollisions,
  hashWidthOf,
  itemTreeEntriesAtCommit,
  namedFilesTreeEntries,
  pinItemAtCommit,
  readEntryBytes,
  sourcePinDigest,
} from "./pin";
import type { PinnedSource, PinTreeEntry } from "./pin";

export interface RemoteInstallRequest {
  project: string;
  /** The cache clone the pin was read from. */
  cachePath: string;
  name: string;
  upstream: string;
  ref: string;
  subpath: string;
  /**
   * The pin the consent gate was shown. Pinning again here would reopen the
   * window between the prompt and the write, so the approved tree is the
   * written tree by construction.
   */
  pin: PinnedSource;
}

export interface RemoteInstallResult {
  entry: RemoteLockEntry;
  path: string;
  action: "created" | "already-current";
  files: number;
}

/** Write the item and return the row. Never saves the lock: the caller does. */
export async function installRemoteSkill(
  request: RemoteInstallRequest,
): Promise<RemoteInstallResult> {
  const entry: RemoteLockEntry = {
    upstream: request.upstream,
    ref: request.ref,
    subpath: request.subpath,
    sourceCommit: request.pin.sourceCommit,
    sourcePinDigest: request.pin.sourcePinDigest,
    appliedAt: new Date().toISOString(),
  };
  const result = await materializeLockEntry({
    project: request.project,
    source: remoteTreeSource(
      request.cachePath,
      request.pin.sourceCommit,
      request.subpath,
    ),
    kind: REMOTE_ITEM_KIND,
    name: request.name,
    // The writer's key is internal and never printed by this path: the result
    // row's `source` is an `ItemSource`, and the row a user sees is built by
    // `status` with `source: "remote"`.
    key: dataKey(REMOTE_ITEM_KIND, request.name),
    entry: remoteEntryAsDataEntry(entry),
    scope: "local",
  });
  return {
    entry,
    path: result.path,
    action: result.action === "already-current" ? "already-current" : "created",
    files: request.pin.entries.length,
  };
}

/** Reconcile an installed remote row against its recorded pin. Offline. */
export async function reconcileRemoteSkill(opts: {
  project: string;
  name: string;
  entry: RemoteLockEntry;
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
}): Promise<MaterializeResult> {
  return await materializeLockEntry({
    project: opts.project,
    source: remoteTreeSource(
      remoteCachePath(opts.entry.upstream, opts.env),
      opts.entry.sourceCommit,
      opts.entry.subpath,
    ),
    kind: REMOTE_ITEM_KIND,
    name: opts.name,
    key: dataKey(REMOTE_ITEM_KIND, opts.name),
    entry: remoteEntryAsDataEntry(opts.entry),
    scope: "local",
    ...(opts.dryRun !== undefined && { dryRun: opts.dryRun }),
  });
}

/**
 * The synthetic data entry a remote row reconciles through.
 *
 * Both needs fields are null, which the pairing refinement allows. The value
 * never reaches a file.
 */
export function remoteEntryAsDataEntry(
  entry: RemoteLockEntry,
): DataLockEntryV4 {
  return {
    source: "data",
    sourcePinDigest: entry.sourcePinDigest,
    sourceCommit: entry.sourceCommit,
    needs: null,
    needsSourceCommit: null,
    appliedAt: entry.appliedAt,
  };
}

/**
 * The refusal every offline command prints for a cache that is not there.
 *
 * `update` and `apply` never create a cache. Creating one would make them
 * network commands, which is the property D15 exists to protect.
 */
export function coldCacheRefusal(
  name: string,
  entry: RemoteLockEntry,
  detail = "has no local cache",
): PreconditionError {
  return new PreconditionError(
    `${remoteKey(name)} ${detail} for ${entry.upstream}`,
    {
      hint:
        "update never creates a cache, because that would make it a network command\n" +
        `  fetch it: ${PRODUCT_NAME} status --check-upstream`,
    },
  );
}

export interface RemoteUpdatePreview {
  from: string;
  to: string;
  /** Item-relative paths that differ between the two pins. */
  changed: string[];
  /** True when the cache already holds the pinned content. */
  current: boolean;
  /** The pin at the cached ref. Null when nothing would move. */
  pin: PinnedSource | null;
}

/** Read the pending change without moving anything. Offline. */
export async function previewRemoteUpdate(opts: {
  project: string;
  name: string;
  entry: RemoteLockEntry;
}): Promise<RemoteUpdatePreview> {
  const { entry, name } = opts;
  const cache = remoteCacheState(entry.upstream);
  if (!cache.present) throw coldCacheRefusal(name, entry);
  const head = await resolveCachedRef(cache.path, entry.ref);
  if (head === null) {
    throw coldCacheRefusal(
      name,
      entry,
      `has no cached ref ${entry.ref} in the cache`,
    );
  }
  const unchanged: RemoteUpdatePreview = {
    from: entry.sourceCommit,
    to: head,
    changed: [],
    current: true,
    pin: null,
  };
  if (head === entry.sourceCommit) return unchanged;

  const pin = await pinItemAtCommit(
    remoteTreeSource(cache.path, head, entry.subpath),
    REMOTE_ITEM_KIND,
    name,
  );
  // Content decides, not the commit. Two skills installed from one repository
  // share a commit, so a repository that moved for the other one leaves this
  // row exactly where it was.
  if (pin.sourcePinDigest === entry.sourcePinDigest) return unchanged;

  const before = await itemTreeEntriesAtCommit(
    remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
    REMOTE_ITEM_KIND,
  ).catch(() => []);
  const previous = new Map(
    before.map((item) => [item.path, `${item.mode}:${item.blobId}`]),
  );
  const next = new Map(
    pin.entries.map((item) => [item.path, `${item.mode}:${item.blobId}`]),
  );
  const changed = [...new Set([...previous.keys(), ...next.keys()])]
    .filter((path) => previous.get(path) !== next.get(path))
    .sort();
  return { from: entry.sourceCommit, to: head, changed, current: false, pin };
}

export interface RemoteUpdateResult {
  /**
   * `skipped` is what a bare `capshelf update` returns for every remote row.
   * A9 forbids a routine sweep from moving a remote pin, and a result value is
   * how the sweep reports the row without a branch that silently drops it.
   */
  action: "updated" | "would-update" | "already-current" | "skipped";
  from: string;
  to: string;
  entry: RemoteLockEntry;
}

/**
 * Move a remote pin to what the cache already holds. Never fetches, and never
 * prompts: the command layer owns consent, because only it can see `--yes`,
 * `--json`, and whether a terminal is attached.
 */
export async function updateRemoteSkill(opts: {
  project: string;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
  dryRun: boolean;
}): Promise<RemoteUpdateResult> {
  const { entry, preview } = opts;
  if (preview.current || preview.pin === null) {
    return {
      action: "already-current",
      from: entry.sourceCommit,
      to: preview.to,
      entry,
    };
  }
  const next: RemoteLockEntry = {
    ...entry,
    sourceCommit: preview.pin.sourceCommit,
    sourcePinDigest: preview.pin.sourcePinDigest,
    appliedAt: new Date().toISOString(),
  };
  await reconcileRemoteSkill({
    project: opts.project,
    name: opts.name,
    entry: next,
    dryRun: opts.dryRun,
  });
  return {
    action: opts.dryRun ? "would-update" : "updated",
    from: entry.sourceCommit,
    to: next.sourceCommit,
    entry: opts.dryRun ? entry : next,
  };
}

export interface RemoteMergeResult extends RemoteUpdateResult {
  merged: boolean;
  mergeBase: string;
  mergeResultDigest: string;
}

/**
 * Three-way merge of the locked pin, the installed copy, and the cached ref.
 *
 * A sibling of `updateMergeTarget` rather than a widening of it. That function's
 * provenance checks all speak in terms of a data repo and a master item, and a
 * remote row has neither; the duplication here is the five steps, and it is
 * smaller than the branching the shared version would need.
 */
export async function updateMergeRemoteTarget(opts: {
  project: string;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
  dryRun: boolean;
}): Promise<RemoteMergeResult> {
  const { project, name, entry, preview } = opts;
  const snapshot = await installedSnapshot(
    project,
    REMOTE_ITEM_KIND,
    name,
    "local",
  );
  if (snapshot === null) {
    throw new PreconditionError(
      `installed item is missing: ${installedPath(project, REMOTE_ITEM_KIND, name)}`,
    );
  }
  const cache = remoteCacheState(entry.upstream);
  if (!cache.present) throw coldCacheRefusal(name, entry);
  const localFiles = await namedFilesFromInstalledSnapshot(snapshot);

  if (preview.current || preview.pin === null) {
    return {
      action: "already-current",
      from: entry.sourceCommit,
      to: preview.to,
      entry,
      merged: false,
      mergeBase: entry.sourceCommit,
      mergeResultDigest: entry.sourcePinDigest,
    };
  }

  // The base has to reproduce the locked pin, or the merge is against content
  // the lock never described. The same guard the shelf merge applies.
  const baseEntries = await itemTreeEntriesAtCommit(
    remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
    REMOTE_ITEM_KIND,
  );
  if (sourcePinDigest(baseEntries) !== entry.sourcePinDigest) {
    throw new PreconditionError(
      `cannot merge ${remoteKey(name)}: the locked commit does not reproduce the locked item content; nothing changed`,
    );
  }
  const [baseFiles, upstreamFiles] = await Promise.all([
    namedFilesFromEntries(cache.path, baseEntries),
    namedFilesFromEntries(cache.path, preview.pin.entries),
  ]);

  const merged = await mergeNamedTrees(baseFiles, localFiles, upstreamFiles);
  if (!merged.ok) {
    throw new PreconditionError(
      `automatic merge conflicts in ${remoteKey(name)}; nothing changed.\n\n` +
        `  conflicting paths:\n${merged.conflicts.map((path) => `    ${path}`).join("\n")}`,
    );
  }
  const performedMerge = !namedFilesEqual(merged.files, upstreamFiles);
  const next: RemoteLockEntry = {
    ...entry,
    sourceCommit: preview.pin.sourceCommit,
    sourcePinDigest: preview.pin.sourcePinDigest,
    appliedAt: new Date().toISOString(),
  };
  const mergeResultDigest = sourcePinDigest(
    namedFilesTreeEntries(merged.files, hashWidthOf(preview.pin.entries)),
  );
  if (opts.dryRun) {
    return {
      action: "would-update",
      from: entry.sourceCommit,
      to: next.sourceCommit,
      entry,
      merged: performedMerge,
      mergeBase: entry.sourceCommit,
      mergeResultDigest,
    };
  }
  if (!namedFilesEqual(localFiles, merged.files)) {
    await assertNoDestinationCollisions(
      remoteKey(name),
      snapshot.localPath,
      merged.files.map((file) => file.path),
    );
    const transaction = await beginInstalledReconciliation(
      snapshot.localPath,
      localFiles,
      merged.files,
    );
    try {
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  return {
    action: "updated",
    from: entry.sourceCommit,
    to: next.sourceCommit,
    entry: next,
    merged: performedMerge,
    mergeBase: entry.sourceCommit,
    mergeResultDigest,
  };
}

/** The bytes of a pinned tree, named the way the merge machinery names them. */
async function namedFilesFromEntries(
  repo: string,
  entries: readonly PinTreeEntry[],
): Promise<NamedFile[]> {
  return (await readEntryBytes(repo, entries))
    .map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.mode,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
