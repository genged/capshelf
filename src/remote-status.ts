/**
 * Offline by construction: rows come from the clone cache, the installed files,
 * and `.capshelf/remotes.lock.json`. Only `status --check-upstream` fetches.
 */
import { describeInstallation, isTreePinned } from "./install-identity";
import { installedPath } from "./installed";
import { pluginRunCounts } from "./plugin-runs";
import type { Lock } from "./lock";
import { dataKey } from "./lock";
import {
  ensureRemoteCache,
  fetchRemoteCache,
  remoteCachePath,
  remoteCacheState,
  resolveCachedRef,
} from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { remoteEntryAsDataEntry } from "./remote-item";
import { REMOTES_LOCK_VERSION, parseRemoteKey } from "./remotes-lock";
import type {
  RemoteItemKind,
  RemoteLockEntry,
  RemotesLock,
} from "./remotes-lock";
import { buildStatusRow, deriveState } from "./status-core";
import type { RemoteRowFacts, StatusRow, StatusRowRuns } from "./status-core";
import type { ClaudeTrust } from "./claude-trust";
import type { ItemRef } from "./item-ref";
import { runtimeWarningsForItem } from "./runtime-warnings";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "./pin";

export interface RemoteStatusInput {
  project: string;
  remotes: RemotesLock;
  projectLock: Lock;
  localLock: Lock;
  claudeTrust: ClaudeTrust;
  ref?: ItemRef;
}

export async function buildRemoteStatusRows(
  input: RemoteStatusInput,
): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  for (const [key, entry] of Object.entries(input.remotes.items)) {
    const { kind, name } = parseRemoteKey(key);
    if (input.ref !== undefined) {
      if (input.ref.name !== name) continue;
      if (input.ref.kind !== undefined && input.ref.kind !== kind) {
        continue;
      }
    }
    rows.push(await buildRemoteRow(input, kind, name, entry));
  }
  return rows;
}

async function buildRemoteRow(
  input: RemoteStatusInput,
  kind: RemoteItemKind,
  name: string,
  entry: RemoteLockEntry,
): Promise<StatusRow> {
  const cache = remoteCacheState(entry.upstream);
  const synthetic = remoteEntryAsDataEntry(entry);
  const installation = cache.present
    ? await describeInstallation(
        input.project,
        remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
        kind,
        name,
        "local",
      )
    : null;
  // A missing cache means an unreadable source, not a missing upstream or
  // install, so the row uses `missing_source_commit` rather than sending the
  // user to an `apply` that refuses.
  const currentSha = installation?.currentSha ?? null;

  const upstream = upstreamFacts(entry);
  const alsoTrackedInShelf =
    input.projectLock.items[dataKey(kind, name)] !== undefined ||
    input.localLock.items[dataKey(kind, name)] !== undefined;

  const state = deriveState({
    kind,
    source: "data",
    local: false,
    lockedSha: entry.sourcePinDigest,
    currentSha,
    upstreamSha: upstream.sha,
    upstreamDirty: false,
    upstreamChanged: upstream.changed,
    fragmentOutputState: null,
    sourceCommitPresent: cache.present ? null : false,
  });

  const runs =
    kind === "plugins"
      ? await remotePluginRuns(input.project, name, entry)
      : null;
  const facts: RemoteRowFacts = {
    upstream: entry.upstream,
    ref: entry.ref,
    subpath: entry.subpath,
    lastChecked: entry.lastChecked ?? null,
    upstreamHead: entry.upstreamHead ?? null,
    cachePresent: cache.present,
    alsoTrackedInShelf,
  };
  return buildStatusRow({
    scope: "local",
    source: "remote",
    remote: facts,
    ...(runs !== null && { runs }),
    ...(kind === "plugins" && { claudeTrust: input.claudeTrust }),
    kind,
    name,
    entry: synthetic,
    state,
    currentSha,
    upstreamSha: upstream.sha,
    upstreamDirty: false,
    runtimeWarnings: runtimeWarningsForItem(input.project, kind, name),
    ...(installation !== null && {
      axes: {
        pin: isTreePinned(synthetic)
          ? installation.pinnedSha === entry.sourcePinDigest
            ? "valid"
            : "mismatch"
          : "unresolvable",
        sourceState: "exact" as const,
        installation: installation.axis,
        visibleExtras: installation.visibleExtras,
        installDifferences: installation.differences.filter(
          (difference) => difference.kind !== "untouched",
        ),
      },
    }),
  });
}

async function remotePluginRuns(
  project: string,
  name: string,
  entry: RemoteLockEntry,
): Promise<StatusRowRuns> {
  const cache = remoteCacheState(entry.upstream);
  return await pluginRunCounts(
    installedPath(project, "plugins", name),
    cache.present
      ? remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath)
      : null,
  );
}

interface UpstreamFacts {
  sha: string | null;
  changed: boolean;
}

/**
 * Compare content, not the repository commit: skills from one repository share
 * a `sourceCommit`, so a commit comparison would mark both updated when either
 * changes.
 */
function upstreamFacts(entry: RemoteLockEntry): UpstreamFacts {
  if (entry.lastChecked === undefined) {
    return { sha: entry.sourcePinDigest, changed: false };
  }
  if (
    entry.upstreamHead === undefined ||
    entry.upstreamPinDigest === undefined
  ) {
    return { sha: null, changed: false };
  }
  return {
    sha: entry.upstreamPinDigest,
    changed: entry.upstreamPinDigest !== entry.sourcePinDigest,
  };
}

export function remoteRowCachePath(entry: RemoteLockEntry): string {
  return remoteCachePath(entry.upstream);
}

export interface UpstreamFetchReport {
  upstream: string;
  ok: boolean;
  head: string | null;
  newCommits: number | null;
  stderr: string;
}

export interface UpstreamCheckReport {
  fetches: UpstreamFetchReport[];
  remotes: RemotesLock;
}

/**
 * Fetch once per repository but decide per row: rows from one repository can
 * sit on different branches, and a moved head is not evidence a given skill
 * moved.
 */
export async function checkRemoteUpstreams(opts: {
  remotes: RemotesLock;
}): Promise<UpstreamCheckReport> {
  const byUpstream = new Map<string, Array<[string, RemoteLockEntry]>>();
  for (const [key, entry] of Object.entries(opts.remotes.items)) {
    byUpstream.set(entry.upstream, [
      ...(byUpstream.get(entry.upstream) ?? []),
      [key, entry],
    ]);
  }

  const fetches: UpstreamFetchReport[] = [];
  const items: Record<string, RemoteLockEntry> = {};
  for (const [upstream, rows] of byUpstream) {
    const outcome = await fetchOneUpstream(upstream, rows);
    fetches.push(outcome.report);
    Object.assign(items, outcome.items);
  }
  return { fetches, remotes: { version: REMOTES_LOCK_VERSION, items } };
}

async function fetchOneUpstream(
  upstream: string,
  rows: ReadonlyArray<[string, RemoteLockEntry]>,
): Promise<{
  report: UpstreamFetchReport;
  items: Record<string, RemoteLockEntry>;
}> {
  const first = rows[0]![1];
  const cache = remoteCacheState(upstream);
  if (!cache.present) {
    // With `--check-upstream`, an absent cache is re-cloned from the normalized
    // URL, so an SSH install is re-cloned over HTTPS. If that cannot
    // authenticate, `capshelf add <ssh-url>` recreates it. Clone errors are
    // caught per repository so one unreachable repository does not abort
    // checks for the others.
    try {
      await ensureRemoteCache(upstream, upstream);
    } catch (error) {
      return {
        report: {
          upstream,
          ok: false,
          head: null,
          newCommits: null,
          stderr: error instanceof Error ? error.message : String(error),
        },
        items: Object.fromEntries(rows),
      };
    }
  }
  const path = remoteCachePath(upstream);
  const fetched = await fetchRemoteCache(path, first.ref, first.sourceCommit);
  if (!fetched.ok) {
    // A failed fetch records no freshness: `lastChecked` means last successful
    // measurement, so a fresh timestamp never sits beside a stale head.
    return {
      report: {
        upstream,
        ok: false,
        head: fetched.head,
        newCommits: fetched.ahead,
        stderr: fetched.stderr,
      },
      items: Object.fromEntries(rows),
    };
  }

  const checkedAt = new Date().toISOString();
  const items: Record<string, RemoteLockEntry> = {};
  for (const [key, entry] of rows) {
    const head =
      entry.ref === first.ref
        ? fetched.head
        : await resolveCachedRef(path, entry.ref);
    if (head === null) {
      // A ref deleted upstream records the timestamp without a head, so the row
      // reads `missing_upstream` instead of healthy.
      const {
        upstreamHead: _wasHead,
        upstreamPinDigest: _wasDigest,
        ...carried
      } = entry;
      items[key] = { ...carried, lastChecked: checkedAt };
      continue;
    }
    // Drop the previous digest before applying the new measurement: an absent
    // digest beside a set head is how a row says the item left its subpath.
    const { upstreamPinDigest: _measuredLastTime, ...carried } = entry;
    items[key] = {
      ...carried,
      lastChecked: checkedAt,
      upstreamHead: head,
      // Compare content, not the commit: skills from one repository share a
      // `sourceCommit`.
      ...(await measuredPinDigest(
        parseRemoteKey(key).kind,
        path,
        head,
        entry.subpath,
      )),
    };
  }
  return {
    report: {
      upstream,
      ok: true,
      head: fetched.head,
      newCommits: fetched.ahead,
      stderr: fetched.stderr,
    },
    items,
  };
}

async function measuredPinDigest(
  kind: RemoteItemKind,
  cachePath: string,
  head: string,
  subpath: string,
): Promise<{ upstreamPinDigest?: string }> {
  try {
    const entries = await itemTreeEntriesAtCommit(
      remoteTreeSource(cachePath, head, subpath),
      kind,
    );
    if (entries.length === 0) return {};
    return { upstreamPinDigest: sourcePinDigest(entries) };
  } catch {
    return {};
  }
}
