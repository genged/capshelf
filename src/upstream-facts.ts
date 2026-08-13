import { findMasterItemByRef } from "./item-ref";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  itemRepoRelPath,
  shaOfGitVisibleItem,
} from "./master";
import {
  currentSourceCommit,
  itemTreeEntriesAtCommit,
  sourcePinDigest,
} from "./pin";
import type { FragmentItemKind, ItemKind } from "./master";
import { isPathClean, lastTouchingContentCommit } from "./git";
import {
  allCanonicalFragmentRelPaths,
  lastTouchingFragmentCommit,
  shaOfFragmentItem,
} from "./fragments";
import {
  lastTouchingSubagentCommit,
  shaOfCurrentSubagent,
  subagentSourceCandidates,
} from "./subagents";

export interface UpstreamFacts {
  /**
   * The identity of the current upstream item, computed the same way the
   * comparing lock entry was pinned. Null when the item is missing, and — for
   * `worktree` identity only — when the source path is dirty.
   */
  upstreamSha: string | null;
  /** true when the data-repo item path has uncommitted changes */
  upstreamDirty: boolean;
  /** Last commit affecting the accepted item content model. */
  sourceCommit: string | null;
}

/**
 * Which identity model the caller's lock entry uses.
 *
 * `tree` (lock version 4) reads the committed tree, so a dirty working copy no
 * longer suppresses the answer: what consumers receive is what Git stores, and
 * a divergent working copy is advisory rather than a correctness fault.
 * `worktree` (lock version 3) keeps the legacy hash so a project that has not
 * migrated still compares like against like.
 */
export type UpstreamIdentity = "tree" | "worktree";

/**
 * The per-item upstream facts the status state machine consumes, shared with
 * promote's stale guard so the two can never disagree (extracted verbatim
 * from the status loop). For fragments, dirtiness is checked across every
 * canonical source path; for copy items, across the item directory.
 */
export async function upstreamFactsForItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  identity: UpstreamIdentity = "worktree",
): Promise<UpstreamFacts> {
  const masterItem = await findMasterItemByRef(dataRepo, { kind, name });
  if (!masterItem) {
    return { upstreamSha: null, upstreamDirty: false, sourceCommit: null };
  }
  if (identity === "tree") {
    const upstreamDirty = await sourcePathsDirty(dataRepo, kind, name);
    const sourceCommit = await currentSourceCommit(dataRepo, kind, name).catch(
      () => null,
    );
    return {
      upstreamSha:
        sourceCommit === null
          ? null
          : sourcePinDigest(
              await itemTreeEntriesAtCommit(dataRepo, kind, name, sourceCommit),
            ),
      upstreamDirty,
      sourceCommit,
    };
  }
  if (isFragmentItemKind(kind)) {
    const upstreamDirty = await fragmentSourceDirty(dataRepo, kind, name);
    return {
      upstreamSha: upstreamDirty
        ? null
        : await shaOfFragmentItem(dataRepo, kind, name),
      upstreamDirty,
      sourceCommit: upstreamDirty
        ? null
        : await lastTouchingFragmentCommit(dataRepo, kind, name),
    };
  }
  if (isCopyDirectoryItemKind(kind)) {
    const upstreamDirty = !(await isPathClean(
      dataRepo,
      masterItem.repoRelPath,
    ));
    return {
      upstreamSha: upstreamDirty
        ? null
        : await shaOfGitVisibleItem(dataRepo, masterItem.repoRelPath),
      upstreamDirty,
      sourceCommit: upstreamDirty
        ? null
        : await lastTouchingContentCommit(dataRepo, masterItem.repoRelPath),
    };
  }
  if (isCopyTargetFileItemKind(kind)) {
    const sources = subagentSourceCandidates("", name);
    const upstreamDirty = (
      await Promise.all(
        sources.map((source) => isPathClean(dataRepo, source.relPath)),
      )
    ).some((clean) => !clean);
    return {
      upstreamSha: upstreamDirty
        ? null
        : await shaOfCurrentSubagent("", dataRepo, name),
      upstreamDirty,
      sourceCommit: upstreamDirty
        ? null
        : await lastTouchingSubagentCommit("", dataRepo, name),
    };
  }
  throw new Error(`no upstream strategy for ${kind}/${name}`);
}

/** Whichever paths define this kind's source, checked for uncommitted change. */
async function sourcePathsDirty(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<boolean> {
  if (isFragmentItemKind(kind)) {
    return await fragmentSourceDirty(dataRepo, kind, name);
  }
  if (isCopyDirectoryItemKind(kind)) {
    return !(await isPathClean(dataRepo, itemRepoRelPath(kind, name)));
  }
  for (const relPath of allCanonicalItemRelPaths(kind, name)) {
    if (!(await isPathClean(dataRepo, relPath))) return true;
  }
  return false;
}

export async function fragmentSourceDirty(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
): Promise<boolean> {
  for (const relPath of allCanonicalFragmentRelPaths(kind, name)) {
    if (!(await isPathClean(dataRepo, relPath))) return true;
  }
  return false;
}
