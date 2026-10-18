/**
 * Pin, install, and reconcile one remote skill or plugin.
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
import { isConfigObject, isConfigString } from "./config-values";
import type { ConfigObject, ConfigValue } from "./config-values";
import { PreconditionError } from "./errors";
import { catFileBlobs } from "./git";
import { METADATA_DIR, PRODUCT_NAME, REMOTES_LOCK_FILE } from "./identity";
import { installedPath } from "./installed";
import { dataKey } from "./lock";
import type { DataLockEntryV4 } from "./lock";
import { installedPreservedEntries, materializeLockEntry } from "./materialize";
import type { MaterializeResult } from "./materialize";
import {
  installedSnapshot,
  namedFilesFromInstalledSnapshot,
} from "./item-snapshot";
import { PLUGIN_MANIFEST_REL } from "./master";
import type { ItemKind } from "./master";
import { mergeNamedTrees, namedFilesEqual } from "./merge-tree";
import type { NamedFile } from "./merge-tree";
import { sanitizeDisplayText } from "./pick-core";
import {
  itemPluginNewRuns,
  itemPluginRunsAtCommit,
  itemPluginRunsFromFiles,
  newRunsEntries,
  pluginExtraFile,
  pluginRunsAtCommit,
} from "./plugin-runs";
import type { PluginExtraFile, PluginRuns } from "./plugin-runs";
import {
  beginInstalledReconciliation,
  keptByInstalledReconciliation,
} from "./promote-transaction";
import { remoteCacheState, resolveCachedRef } from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { remoteKey } from "./remotes-lock";
import type { RemoteItemKind, RemoteLockEntry } from "./remotes-lock";
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
  kind: RemoteItemKind;
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
export async function installRemoteItem(
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
    kind: request.kind,
    name: request.name,
    // The writer's key is internal and never printed by this path: the result
    // row's `source` is an `ItemSource`, and the row a user sees is built by
    // `status` with `source: "remote"`.
    key: dataKey(request.kind, request.name),
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
export async function reconcileRemoteItem(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  /**
   * The pin being replaced, when this reconcile moves one.
   *
   * Without it `materializeLockEntry` treats the new pin as the previous one,
   * so a path the new commit dropped is not known to have been managed. A
   * dropped path that reads as hidden to `visibleExtraPaths` would then be
   * preserved as the user's file and survive the update. The shelf pass in
   * `update` supplies the same value for the same reason; `apply` converges to
   * the pin it already holds and has none.
   */
  previous?: RemoteLockEntry;
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
}): Promise<MaterializeResult> {
  // The refusal belongs here, with the derivation of the path: every caller
  // that reconciles offline needs it, and one that only built the path reported
  // whatever git printed about a directory that is not a repository.
  const cache = remoteCacheState(opts.entry.upstream, opts.env);
  if (!cache.present) throw coldCacheRefusal(opts.kind, opts.name, opts.entry);
  return await materializeLockEntry({
    project: opts.project,
    source: remoteTreeSource(
      cache.path,
      opts.entry.sourceCommit,
      opts.entry.subpath,
    ),
    kind: opts.kind,
    name: opts.name,
    key: dataKey(opts.kind, opts.name),
    entry: remoteEntryAsDataEntry(opts.entry),
    scope: "local",
    ...(opts.previous !== undefined && {
      previous: {
        entry: remoteEntryAsDataEntry(opts.previous),
        source: remoteTreeSource(
          cache.path,
          opts.previous.sourceCommit,
          opts.previous.subpath,
        ),
      },
    }),
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
  kind: RemoteItemKind,
  name: string,
  entry: RemoteLockEntry,
  detail = "has no local cache",
): PreconditionError {
  // The fetch command is in the message, not only in the hint. A sweep records
  // this refusal as a result row, and a row carries the message alone, so a
  // hint-only instruction would never reach the one caller that cannot rerun
  // the command to see it.
  return new PreconditionError(
    `${remoteKey(kind, name)} ${detail} for ${entry.upstream}; fetch it with ${PRODUCT_NAME} status --check-upstream`,
    {
      hint: `${PRODUCT_NAME} never creates a cache offline, because that would make this a network command`,
    },
  );
}

/**
 * The refusal a verb with nowhere to publish prints for a remote skill.
 *
 * `promote`, `move`, `keep-local`, and `revert` all act on an item the shelf
 * owns. A remote skill's upstream is a repository nobody on the team can
 * publish to, and its record is a different document, so `share --adopt` is the
 * one exit. Every verb prints the same two facts, so they cannot drift apart.
 */
export function remoteVerbRefusal(
  verb: string,
  kind: RemoteItemKind,
  name: string,
): PreconditionError {
  const ref = `${kind}/${name}`;
  return new PreconditionError(
    `not ${verb} ${ref} — it is a remote item, tracked in ${METADATA_DIR}/${REMOTES_LOCK_FILE} rather than in your shelf`,
    {
      hint:
        `take ownership of it first: ${PRODUCT_NAME} share ${ref} --adopt\n` +
        `  or remove it: ${PRODUCT_NAME} rm ${ref}`,
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
  /** A plugin row's pin move. Null for a skill row and when nothing moves. */
  plugin: RemotePluginChange | null;
  /**
   * The runs entries the new pin adds (D7 point 2): for a plugin row, and
   * for a skill row whose new tree holds a plugin manifest, because Claude
   * Code loads that skill as a plugin (R1). Null for any other row and when
   * nothing moves.
   */
  newRuns: PluginRuns | null;
}

/** What a plugin pin move changes in what the consent prompt reports. */
export interface RemotePluginChange {
  /** The manifest `version` at the old pin, or null when it has none. */
  versionFrom: string | null;
  /** The manifest `version` at the new pin, or null when it has none. */
  versionTo: string | null;
  /** The runs entries the new pin has and the old pin did not (D7 point 2). */
  newRuns: PluginRuns;
}

/** Read the pending change without moving anything. Offline. */
export async function previewRemoteUpdate(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
}): Promise<RemoteUpdatePreview> {
  const { entry, kind, name } = opts;
  const cache = remoteCacheState(entry.upstream);
  if (!cache.present) throw coldCacheRefusal(kind, name, entry);
  const head = await resolveCachedRef(cache.path, entry.ref);
  if (head === null) {
    throw coldCacheRefusal(
      kind,
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
    plugin: null,
    newRuns: null,
  };
  if (head === entry.sourceCommit) return unchanged;

  const pin = await pinItemAtCommit(
    remoteTreeSource(cache.path, head, entry.subpath),
    kind,
    name,
  );
  // Content decides, not the commit. Two skills installed from one repository
  // share a commit, so a repository that moved for the other one leaves this
  // row exactly where it was.
  if (pin.sourcePinDigest === entry.sourcePinDigest) return unchanged;

  const before = await itemTreeEntriesAtCommit(
    remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
    kind,
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
  // The move keeps ignored local files beside the new pinned files (row 4),
  // so the runs reader reads both. A kept local manifest can arm a hook the
  // new tree adds.
  const extras = (
    await installedPreservedEntries({
      project: opts.project,
      kind,
      name,
      scope: "local",
      managedPaths: new Set([
        ...before.map((item) => item.path),
        ...pin.entries.map((item) => item.path),
      ]),
    })
  ).map(pluginExtraFile);
  const plugin =
    kind === "plugins"
      ? await pluginChange(cache.path, name, before, pin.entries, extras)
      : null;
  const newRuns =
    plugin !== null
      ? plugin.newRuns
      : await itemPluginNewRuns(cache.path, kind, before, pin.entries, extras);
  return {
    from: entry.sourceCommit,
    to: head,
    changed,
    current: false,
    pin,
    plugin,
    newRuns,
  };
}

/**
 * D3 and D7 point 2 for a plugin pin move. The new tree must keep the item
 * name in its manifest, or the move refuses before any write: Claude Code
 * names the plugin from the manifest, so a renamed tree installed under the
 * old folder would load under a name that no capshelf row holds.
 *
 * `previewRemoteUpdate` is the one producer of the pin that `updateRemoteItem`
 * and `updateMergeRemoteTarget` write, and the dry run reads the same
 * preview, so this one check covers every remote update path. The shelf
 * `update` calls it with the data repo for a `data/plugins/<n>` pin move.
 */
export async function pluginChange(
  repo: string,
  name: string,
  before: readonly PinTreeEntry[],
  after: readonly PinTreeEntry[],
  extras: readonly PluginExtraFile[] = [],
): Promise<RemotePluginChange> {
  const [manifestBefore, manifestAfter] = await Promise.all([
    pluginManifestAt(repo, before),
    pluginManifestAt(repo, after),
  ]);
  const renamedTo = manifestString(manifestAfter, "name");
  if (renamedTo !== name) {
    throw pluginRenameRefusal(name, renamedTo);
  }
  const [runsBefore, runsAfter] = await Promise.all([
    pluginRunsAtCommit(repo, before, extras),
    pluginRunsAtCommit(repo, after, extras),
  ]);
  return {
    versionFrom: manifestString(manifestBefore, "version"),
    versionTo: manifestString(manifestAfter, "version"),
    newRuns: newRunsEntries(runsBefore, runsAfter),
  };
}

/** The refusal for a new tree whose manifest names another plugin (D3). */
function pluginRenameRefusal(
  name: string,
  manifestName: string | null,
): PreconditionError {
  const ref = `plugins/${name}`;
  const found =
    manifestName === null
      ? `has no plugin name in ${PLUGIN_MANIFEST_REL}`
      : `names the plugin "${sanitizeDisplayText(manifestName)}" in ${PLUGIN_MANIFEST_REL}`;
  return new PreconditionError(`${ref}: the new tree ${found}`, {
    hint:
      `the item name is "${name}". ${PRODUCT_NAME} does not rename an item.\n` +
      `  to take the renamed plugin: ${PRODUCT_NAME} rm ${ref}, then add it again`,
  });
}

/**
 * The manifest in a pinned plugin tree, parsed. Null when the tree holds no
 * regular manifest blob, or when the blob is not a JSON object.
 */
async function pluginManifestAt(
  repo: string,
  entries: readonly PinTreeEntry[],
): Promise<ConfigObject | null> {
  const entry = entries.find(
    (candidate) =>
      candidate.path === PLUGIN_MANIFEST_REL &&
      (candidate.mode === "100644" || candidate.mode === "100755"),
  );
  if (entry === undefined) return null;
  const bytes = (await catFileBlobs(repo, [entry.blobId])).get(entry.blobId);
  if (bytes === undefined) return null;
  let parsed: ConfigValue;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return isConfigObject(parsed) ? parsed : null;
}

/**
 * D3 for a merge result: the files a merge writes keep the item name in
 * their manifest. A local edit can rename the plugin while the upstream
 * changes another file, so the upstream check alone does not cover it. A
 * merged tree with no manifest is not checked here.
 */
export function assertMergedPluginName(
  kind: ItemKind,
  name: string,
  files: readonly NamedFile[],
): void {
  if (kind !== "plugins") return;
  const file = files.find(
    (candidate) => candidate.path === PLUGIN_MANIFEST_REL,
  );
  if (file === undefined) return;
  let parsed: ConfigValue = null;
  try {
    parsed = JSON.parse(file.content.toString("utf8"));
  } catch {
    // An unparseable manifest names no plugin.
  }
  const manifestName = manifestString(
    isConfigObject(parsed) ? parsed : null,
    "name",
  );
  if (manifestName !== name) throw pluginRenameRefusal(name, manifestName);
}

function manifestString(
  manifest: ConfigObject | null,
  field: string,
): string | null {
  const value = manifest?.[field];
  return isConfigString(value) ? value : null;
}

/**
 * The freshness fields a moved pin carries.
 *
 * `lastChecked`, `upstreamHead`, and `upstreamPinDigest` describe one
 * measurement of the repository. Carrying them across a pin move leaves the row
 * claiming the upstream holds content the pin has already taken: `status` then
 * reports `update_available` against a digest *older* than the pin, `--strict`
 * fails, and the update it suggests answers `already-current`. Only the next
 * check clears it.
 *
 * A move onto the head the check recorded consumes exactly that measurement, so
 * the timestamp and head still hold and the digest becomes the pinned one. A
 * move onto anything else means the cache ran ahead of the check — `add <url>`
 * fetches a warm cache — and nothing measured is true of it, so the row goes
 * back to never checked.
 */
function freshnessAfterMove(
  entry: RemoteLockEntry,
  movedTo: string,
  pinnedDigest: string,
): Pick<RemoteLockEntry, "lastChecked" | "upstreamHead" | "upstreamPinDigest"> {
  if (entry.lastChecked === undefined || entry.upstreamHead !== movedTo) {
    return {};
  }
  return {
    lastChecked: entry.lastChecked,
    upstreamHead: entry.upstreamHead,
    upstreamPinDigest: pinnedDigest,
  };
}

/** The moved row, with the previous check's measurement resolved, not carried. */
function movedRemoteEntry(
  entry: RemoteLockEntry,
  pin: PinnedSource,
): RemoteLockEntry {
  const {
    lastChecked: _wasChecked,
    upstreamHead: _wasHead,
    upstreamPinDigest: _wasDigest,
    ...carried
  } = entry;
  return {
    ...carried,
    sourceCommit: pin.sourceCommit,
    sourcePinDigest: pin.sourcePinDigest,
    appliedAt: new Date().toISOString(),
    ...freshnessAfterMove(entry, pin.sourceCommit, pin.sourcePinDigest),
  };
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
export async function updateRemoteItem(opts: {
  project: string;
  kind: RemoteItemKind;
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
  const next = movedRemoteEntry(entry, preview.pin);
  await reconcileRemoteItem({
    project: opts.project,
    kind: opts.kind,
    name: opts.name,
    entry: next,
    previous: entry,
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
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
  dryRun: boolean;
  /**
   * The merged files a consent prompt approved. The merge refuses when its
   * own result differs, so the approved files are the written files.
   */
  approvedFiles?: readonly NamedFile[];
}): Promise<RemoteMergeResult> {
  const { kind, name, entry } = opts;
  const plan = await planRemoteMerge(opts);
  if (plan.kind === "current") {
    return {
      action: "already-current",
      from: entry.sourceCommit,
      to: plan.to,
      entry,
      merged: false,
      mergeBase: entry.sourceCommit,
      mergeResultDigest: entry.sourcePinDigest,
    };
  }
  const { snapshot, localFiles, files, pin } = plan;
  if (
    opts.approvedFiles !== undefined &&
    !namedFilesEqual([...opts.approvedFiles], files)
  ) {
    throw new PreconditionError(
      `${remoteKey(kind, name)} changed while the prompt was open; nothing was written. Rerun update --merge.`,
    );
  }
  const upstreamFiles = plan.upstreamFiles;
  const performedMerge = !namedFilesEqual(files, upstreamFiles);
  const next = movedRemoteEntry(entry, pin);
  const mergeResultDigest = sourcePinDigest(
    namedFilesTreeEntries(files, hashWidthOf(pin.entries)),
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
  if (!namedFilesEqual(localFiles, files)) {
    await assertNoDestinationCollisions(
      remoteKey(kind, name),
      snapshot.localPath,
      files.map((file) => file.path),
    );
    const transaction = await beginInstalledReconciliation(
      snapshot.localPath,
      localFiles,
      files,
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

type RemoteMergePlan =
  | { kind: "current"; to: string }
  | {
      kind: "merge";
      snapshot: NonNullable<Awaited<ReturnType<typeof installedSnapshot>>>;
      localFiles: NamedFile[];
      upstreamFiles: NamedFile[];
      baseEntries: PinTreeEntry[];
      cachePath: string;
      /** The merged files the write puts in the folder. */
      files: NamedFile[];
      pin: PinnedSource;
    };

/** The merge `updateMergeRemoteTarget` writes, computed and not written. */
async function planRemoteMerge(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
}): Promise<RemoteMergePlan> {
  const { project, kind, name, entry, preview } = opts;
  const snapshot = await installedSnapshot(project, kind, name, "local");
  if (snapshot === null) {
    throw new PreconditionError(
      `installed item is missing: ${installedPath(project, kind, name)}`,
    );
  }
  const cache = remoteCacheState(entry.upstream);
  if (!cache.present) throw coldCacheRefusal(kind, name, entry);
  const localFiles = await namedFilesFromInstalledSnapshot(snapshot);

  if (preview.current || preview.pin === null) {
    return { kind: "current", to: preview.to };
  }

  // The base has to reproduce the locked pin, or the merge is against content
  // the lock never described. The same guard the shelf merge applies.
  const baseEntries = await itemTreeEntriesAtCommit(
    remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
    kind,
  );
  if (sourcePinDigest(baseEntries) !== entry.sourcePinDigest) {
    throw new PreconditionError(
      `cannot merge ${remoteKey(kind, name)}: the locked commit does not reproduce the locked item content; nothing changed`,
    );
  }
  const [baseFiles, upstreamFiles] = await Promise.all([
    namedFilesFromEntries(cache.path, baseEntries),
    namedFilesFromEntries(cache.path, preview.pin.entries),
  ]);

  const merged = await mergeNamedTrees(baseFiles, localFiles, upstreamFiles);
  if (!merged.ok) {
    throw new PreconditionError(
      `automatic merge conflicts in ${remoteKey(kind, name)}; nothing changed.\n\n` +
        `  conflicting paths:\n${merged.conflicts.map((path) => `    ${path}`).join("\n")}`,
    );
  }
  assertMergedPluginName(kind, name, merged.files);
  return {
    kind: "merge",
    snapshot,
    localFiles,
    upstreamFiles,
    baseEntries,
    cachePath: cache.path,
    files: merged.files,
    pin: preview.pin,
  };
}

/**
 * D7 point 2 for a remote `update --merge`: the runs entries the merged
 * files add over the locked pin, and those files. A merge can run a command
 * that neither the local copy nor the upstream runs alone, so the prompt
 * reads the merged files. Null `files` when nothing would move; `newRuns` is
 * null when the merged files are not a plugin to Claude Code.
 */
export async function remoteMergeNewRuns(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
}): Promise<{ newRuns: PluginRuns | null; files: NamedFile[] | null }> {
  const plan = await planRemoteMerge(opts);
  if (plan.kind === "current") {
    return { newRuns: opts.preview.newRuns, files: null };
  }
  // Every installed entry the merge writer keeps, from the writer's rule.
  const extras = await keptByInstalledReconciliation(
    plan.snapshot.localPath,
    plan.localFiles,
    plan.files,
  );
  const merged = await itemPluginRunsFromFiles(opts.kind, plan.files, extras);
  if (merged === null) return { newRuns: null, files: plan.files };
  const previous = (await itemPluginRunsAtCommit(
    plan.cachePath,
    opts.kind,
    plan.baseEntries,
    extras,
  )) ?? { hooks: [], mcpServers: [], unknown: [] };
  return { newRuns: newRunsEntries(previous, merged), files: plan.files };
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
