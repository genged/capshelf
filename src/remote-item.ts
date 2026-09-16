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
import { dataKey } from "./lock";
import type { DataLockEntryV4 } from "./lock";
import { materializeLockEntry } from "./materialize";
import type { MaterializeResult } from "./materialize";
import { remoteCachePath } from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { REMOTE_ITEM_KIND } from "./remotes-lock";
import type { RemoteLockEntry } from "./remotes-lock";
import type { PinnedSource } from "./pin";

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
