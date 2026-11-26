/**
 * Reuses the copy-directory reconciler instead of a second object model; the
 * synthetic `DataLockEntryV4` carries the remote digest and is never
 * serialized.
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
import type { KeptInstalledEntry } from "./promote-transaction";
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
  cachePath: string;
  kind: RemoteItemKind;
  name: string;
  upstream: string;
  ref: string;
  subpath: string;
  /**
   * The pin the consent gate showed. Pinning again would reopen a window
   * between prompt and write, so the approved tree is the written tree.
   */
  pin: PinnedSource;
}

export interface RemoteInstallResult {
  entry: RemoteLockEntry;
  path: string;
  action: "created" | "already-current";
  files: number;
}

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

export async function reconcileRemoteItem(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  /**
   * Without the previous pin, a path the new commit dropped is not known to be
   * managed. If it is ignored by Git, it is kept as the user's file and
   * survives the update.
   */
  previous?: RemoteLockEntry;
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
}): Promise<MaterializeResult> {
  // Refuse a cold cache here: a caller that only built the path would surface
  // git's error about a non-repository directory.
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
 * `update` and `apply` never create a cache, since that would make them network
 * commands.
 */
export function coldCacheRefusal(
  kind: RemoteItemKind,
  name: string,
  entry: RemoteLockEntry,
  detail = "has no local cache",
): PreconditionError {
  // The fetch command is in the message, not just the hint, because a sweep
  // records only the message in its result row.
  return new PreconditionError(
    `${remoteKey(kind, name)} ${detail} for ${entry.upstream}; fetch it with ${PRODUCT_NAME} status --check-upstream`,
    {
      hint: `${PRODUCT_NAME} never creates a cache offline, because that would make this a network command`,
    },
  );
}

/**
 * A remote skill's upstream isn't publishable by the team, so `share --adopt`
 * is the only exit; one shared refusal keeps every verb consistent.
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
  changed: string[];
  current: boolean;
  pin: PinnedSource | null;
  plugin: RemotePluginChange | null;
  /**
   * The runs entries the new pin adds: for a plugin row, and for a skill row
   * whose new tree holds a plugin manifest, because Claude Code loads that
   * skill as a plugin. Null for any other row and when nothing moves.
   */
  newRuns: PluginRuns | null;
}

export interface RemotePluginChange {
  versionFrom: string | null;
  versionTo: string | null;
  newRuns: PluginRuns;
}

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
  // Compare content, not commits: skills from one repository share a commit, so
  // another skill's move must not change this row.
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
  // The move keeps ignored local files, and a kept local manifest can arm a
  // hook the new tree adds, so read both.
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
 * The new tree must keep the item name in its manifest, or the move refuses
 * before any write: Claude Code names the plugin from the manifest, so a
 * renamed tree would load under a name no row holds.
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
 * Check the merged result too: a local edit can rename the plugin while
 * upstream changes another file.
 */
export function assertMergedPluginName(
  kind: ItemKind,
  name: string,
  files: readonly NamedFile[],
  kept: readonly KeptInstalledEntry[],
): void {
  if (kind !== "plugins") return;
  // An ignored installed manifest isn't in `files` but stays in the folder, and
  // Claude Code loads it.
  const file =
    files.find((candidate) => candidate.path === PLUGIN_MANIFEST_REL) ??
    kept.find((candidate) => candidate.path === PLUGIN_MANIFEST_REL);
  if (file === undefined) return;
  let parsed: ConfigValue = null;
  try {
    if (file.content !== null) {
      parsed = JSON.parse(file.content.toString("utf8"));
    }
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
 * Freshness fields measure one check; carrying them across a pin move would
 * claim upstream holds content the pin already took, so they are kept only when
 * the move lands on the checked head.
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
   * `skipped` lets a bare `update` report a remote row without moving its pin,
   * rather than silently dropping it.
   */
  action: "updated" | "would-update" | "already-current" | "skipped";
  from: string;
  to: string;
  entry: RemoteLockEntry;
}

/**
 * Never prompts: the command layer owns consent because only it sees `--yes`,
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
    entry: next,
  };
}

export interface RemoteMergeResult extends RemoteUpdateResult {
  merged: boolean;
  mergeBase: string;
  mergeResultDigest: string;
}

/**
 * Sibling of `updateMergeTarget` rather than a widening: its provenance checks
 * assume a data repo and master item, which a remote row lacks.
 */
export async function updateMergeRemoteTarget(opts: {
  project: string;
  kind: RemoteItemKind;
  name: string;
  entry: RemoteLockEntry;
  preview: RemoteUpdatePreview;
  dryRun: boolean;
  /**
   * The merge refuses when its result differs from the approved files, so
   * approved files are the written files.
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
      entry: next,
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
      { root: opts.project },
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
      files: NamedFile[];
      kept: KeptInstalledEntry[];
      pin: PinnedSource;
    };

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

  // The base must reproduce the locked pin, or the merge is against content the
  // lock never described.
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
  const kept = await keptByInstalledReconciliation(
    snapshot.localPath,
    localFiles,
    merged.files,
  );
  assertMergedPluginName(kind, name, merged.files, kept);
  return {
    kind: "merge",
    snapshot,
    localFiles,
    upstreamFiles,
    baseEntries,
    cachePath: cache.path,
    files: merged.files,
    kept,
    pin: preview.pin,
  };
}

/**
 * A merge can run a command neither side runs alone, so the consent prompt
 * reads the merged files.
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
  const extras = plan.kept;
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
