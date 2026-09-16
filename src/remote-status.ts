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
import { remoteCachePath, remoteCacheState } from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { remoteEntryAsDataEntry } from "./remote-item";
import { REMOTE_ITEM_KIND, parseRemoteKey } from "./remotes-lock";
import type { RemoteLockEntry, RemotesLock } from "./remotes-lock";
import { buildStatusRow, deriveState } from "./status-core";
import type { RemoteRowFacts, StatusRow } from "./status-core";
import type { ItemRef } from "./item-ref";
import { runtimeWarningsForItem } from "./runtime-warnings";

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
interface UpstreamFacts {
  /** The identity `deriveState` compares the pin against, or null. */
  sha: string | null;
  changed: boolean;
}

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
