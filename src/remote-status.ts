/**
 * Status rows for pulled skills.
 *
 * Offline by construction. Everything here reads the clone cache the install
 * left behind and the record in `.capshelf/remotes.lock.json`; `status
 * --check-upstream` is the one path that fetches, and it lives beside this.
 */
import { describeInstallation, isTreePinned } from "./install-identity";
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
import {
  REMOTES_LOCK_VERSION,
  REMOTE_ITEM_KIND,
  parseRemoteKey,
} from "./remotes-lock";
import type { RemoteLockEntry, RemotesLock } from "./remotes-lock";
import { buildStatusRow, deriveState } from "./status-core";
import type { RemoteRowFacts, StatusRow } from "./status-core";
import type { ItemRef } from "./item-ref";
import { runtimeWarningsForItem } from "./runtime-warnings";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "./pin";

export interface RemoteStatusInput {
  project: string;
  remotes: RemotesLock;
  projectLock: Lock;
  localLock: Lock;
  ref?: ItemRef;
}

export async function buildRemoteStatusRows(
  input: RemoteStatusInput,
): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  for (const [key, entry] of Object.entries(input.remotes.items)) {
    const { name } = parseRemoteKey(key);
    if (input.ref !== undefined) {
      if (input.ref.name !== name) continue;
      if (input.ref.kind !== undefined && input.ref.kind !== REMOTE_ITEM_KIND) {
        continue;
      }
    }
    rows.push(await buildRemoteRow(input, name, entry));
  }
  return rows;
}

async function buildRemoteRow(
  input: RemoteStatusInput,
  name: string,
  entry: RemoteLockEntry,
): Promise<StatusRow> {
  const cache = remoteCacheState(entry.upstream);
  const synthetic = remoteEntryAsDataEntry(entry);
  // The same reader the shelf rows use. It takes a `GitTreeSource`, so a remote
  // row passes one naming the cache clone and its own subpath and the function
  // needs no change at all.
  const installation = cache.present
    ? await describeInstallation(
        input.project,
        remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath),
        REMOTE_ITEM_KIND,
        name,
      )
    : null;
  // A missing cache is not a missing upstream: the upstream is the repository,
  // not the clone. When the install is present the row stays `ok` on the
  // installed axis and the detail line says the cache is absent.
  const currentSha = installation?.currentSha ?? null;

  const upstream = upstreamFacts(entry);
  const alsoTrackedInShelf =
    input.projectLock.items[dataKey(REMOTE_ITEM_KIND, name)] !== undefined ||
    input.localLock.items[dataKey(REMOTE_ITEM_KIND, name)] !== undefined;

  const state = deriveState({
    kind: REMOTE_ITEM_KIND,
    // A remote row does have a real upstream, so it takes the data branch of
    // the state machine. The record it lives in is a different question.
    source: "data",
    local: false,
    lockedSha: entry.sourcePinDigest,
    currentSha,
    upstreamSha: upstream.sha,
    upstreamDirty: false,
    upstreamChanged: upstream.changed,
    fragmentOutputState: null,
    sourceCommitPresent: null,
  });

  const facts: RemoteRowFacts = {
    upstream: entry.upstream,
    ref: entry.ref,
    subpath: entry.subpath,
    lastChecked: entry.lastChecked ?? null,
    upstreamHead: entry.upstreamHead ?? null,
    alsoTrackedInShelf,
  };
  return buildStatusRow({
    scope: "local",
    source: "remote",
    remote: facts,
    kind: REMOTE_ITEM_KIND,
    name,
    entry: synthetic,
    state,
    currentSha,
    upstreamSha: upstream.sha,
    upstreamDirty: false,
    runtimeWarnings: runtimeWarningsForItem(
      input.project,
      REMOTE_ITEM_KIND,
      name,
    ),
    ...(installation !== null && {
      axes: {
        pin: isTreePinned(synthetic)
          ? installation.pinnedSha === entry.sourcePinDigest
            ? "valid"
            : "mismatch"
          : "unresolvable",
        sourceState: "exact" as const,
        installation: installation.axis,
        installDifferences: installation.differences.filter(
          (difference) => difference.kind !== "untouched",
        ),
      },
    }),
  });
}

interface UpstreamFacts {
  /** The identity `deriveState` compares the pin against, or null. */
  sha: string | null;
  changed: boolean;
}

/**
 * What the last successful check measured.
 *
 * Content is compared, never the repository commit: two skills installed from
 * one repository share a `sourceCommit`, so comparing commits would mark both
 * updated when either one changes.
 *
 * A row nobody has checked reports its own pin, which reads `ok` and says it
 * was never checked. A check that reached the repository and found nothing at
 * the recorded subpath records the head with no digest, which is
 * `missing_upstream`.
 */
function upstreamFacts(entry: RemoteLockEntry): UpstreamFacts {
  if (entry.lastChecked === undefined) {
    return { sha: entry.sourcePinDigest, changed: false };
  }
  if (entry.upstreamPinDigest === undefined) {
    return { sha: null, changed: false };
  }
  return {
    sha: entry.upstreamPinDigest,
    changed: entry.upstreamPinDigest !== entry.sourcePinDigest,
  };
}

/** The cache path a remote row reads, for a caller that has to name it. */
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
  /** One entry per distinct upstream, in the order they were fetched. */
  fetches: UpstreamFetchReport[];
  /** The updated rows, ready to be saved. */
  remotes: RemotesLock;
}

/**
 * The one fetch a read-only command performs.
 *
 * Fetch per repository, decide per row. Those are two different groupings: a
 * repository is fetched once, and each row then resolves its own `ref` and
 * re-pins its own subpath, because two rows from one repository can sit on
 * different branches and a moved repository head is not evidence that a
 * particular skill moved.
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
    // The flag re-creates an absent cache through the same `ensureClone` rule
    // the install used. `ensureClone` throws where `fetchOrigin` reports, so
    // the failure is caught and recorded per row: one unreachable repository
    // must not abort the check for every other one. Maintainer decision,
    // 2026-09-16.
    //
    // The clone URL is the normalized identity, because that is the only form
    // the record holds. A repository installed over SSH is therefore re-cloned
    // over HTTPS; if that cannot authenticate, `capshelf add <ssh-url>`
    // re-creates the cache with the URL the user typed.
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
    // A failed fetch records no freshness. `lastChecked` means "last
    // successful measurement", never "last attempt", because a fresh timestamp
    // beside a stale head is the one thing the report must never imply.
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
      items[key] = entry;
      continue;
    }
    items[key] = {
      ...entry,
      lastChecked: checkedAt,
      upstreamHead: head,
      // Compare content, never the repository commit. Two skills installed
      // from one repository share a `sourceCommit`, so a commit comparison
      // marks both updated when either one changes.
      ...(await measuredPinDigest(path, head, entry.subpath)),
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

/**
 * The item's digest at the measured head, or no digest at all when the item is
 * no longer there. An absent digest beside a present head is `missing_upstream`.
 */
async function measuredPinDigest(
  cachePath: string,
  head: string,
  subpath: string,
): Promise<{ upstreamPinDigest?: string }> {
  try {
    const entries = await itemTreeEntriesAtCommit(
      remoteTreeSource(cachePath, head, subpath),
      REMOTE_ITEM_KIND,
    );
    if (entries.length === 0) return {};
    return { upstreamPinDigest: sourcePinDigest(entries) };
  } catch {
    return {};
  }
}
