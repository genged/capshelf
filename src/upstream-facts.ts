import type { GitReadMemo } from "./git-read-memo";
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
import { gitTreeSource } from "./item-source";
import type { FragmentItemKind, ItemKind } from "./master";
import { isPathClean, lastTouchingContentCommit } from "./git";
import type { PathCleanCheck } from "./git";
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
  memo?: GitReadMemo,
  isClean: PathCleanCheck = (relPath) => isPathClean(dataRepo, relPath),
  /**
   * The data-repo `HEAD` the caller read once. With it, the commit walk starts
   * there instead of at the live `HEAD`, and `memo` can answer it.
   */
  head?: string,
): Promise<UpstreamFacts> {
  const masterItem = await findMasterItemByRef(dataRepo, { kind, name });
  if (!masterItem) {
    return { upstreamSha: null, upstreamDirty: false, sourceCommit: null };
  }
  if (identity === "tree") {
    const upstreamDirty = await sourcePathsDirty(kind, name, isClean);
    const sourceCommit = await currentSourceCommit(dataRepo, kind, name, {
      head,
      memo,
    }).catch(() => null);
    return {
      upstreamSha:
        sourceCommit === null
          ? null
          : sourcePinDigest(
              await itemTreeEntriesAtCommit(
                gitTreeSource({
                  repo: dataRepo,
                  kind,
                  name,
                  commit: sourceCommit,
                }),
                kind,
                memo,
              ),
            ),
      upstreamDirty,
      sourceCommit,
    };
  }
  if (isFragmentItemKind(kind)) {
    const upstreamDirty = await fragmentSourceDirty(
      dataRepo,
      kind,
      name,
      isClean,
    );
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
    const upstreamDirty = !(await isClean(masterItem.repoRelPath));
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
      await Promise.all(sources.map((source) => isClean(source.relPath)))
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
  kind: ItemKind,
  name: string,
  isClean: PathCleanCheck,
): Promise<boolean> {
  if (isFragmentItemKind(kind)) {
    for (const relPath of allCanonicalFragmentRelPaths(kind, name)) {
      if (!(await isClean(relPath))) return true;
    }
    return false;
  }
  if (isCopyDirectoryItemKind(kind)) {
    return !(await isClean(itemRepoRelPath(kind, name)));
  }
  for (const relPath of allCanonicalItemRelPaths(kind, name)) {
    if (!(await isClean(relPath))) return true;
  }
  return false;
}

export async function fragmentSourceDirty(
  dataRepo: string,
  kind: FragmentItemKind,
  name: string,
  isClean: PathCleanCheck = (relPath) => isPathClean(dataRepo, relPath),
): Promise<boolean> {
  for (const relPath of allCanonicalFragmentRelPaths(kind, name)) {
    if (!(await isClean(relPath))) return true;
  }
  return false;
}
