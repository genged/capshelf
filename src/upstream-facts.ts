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
  upstreamSha: string | null;
  upstreamDirty: boolean;
  sourceCommit: string | null;
}

/**
 * `tree` reads the committed tree, so a dirty working copy is advisory rather
 * than suppressing the answer; `worktree` keeps the legacy hash so unmigrated
 * projects compare like with like.
 */
export type UpstreamIdentity = "tree" | "worktree";

export interface UpstreamFactsOptions {
  memo?: GitReadMemo;
  isClean?: PathCleanCheck;
  /**
   * With `head`, the commit walk starts at the caller's single read instead of
   * the live `HEAD`, so `memo` can answer it.
   */
  head?: string;
}

/** Shared with promote's stale guard so the two cannot disagree. */
export async function upstreamFactsForItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  identity: UpstreamIdentity = "worktree",
  options: UpstreamFactsOptions = {},
): Promise<UpstreamFacts> {
  const {
    memo,
    isClean = (relPath) => isPathClean(dataRepo, relPath),
    head,
  } = options;
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
    const upstreamDirty = await fragmentSourceDirty(kind, name, isClean);
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

async function sourcePathsDirty(
  kind: ItemKind,
  name: string,
  isClean: PathCleanCheck,
): Promise<boolean> {
  if (isFragmentItemKind(kind)) {
    return await fragmentSourceDirty(kind, name, isClean);
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
  kind: FragmentItemKind,
  name: string,
  isClean: PathCleanCheck,
): Promise<boolean> {
  for (const relPath of allCanonicalFragmentRelPaths(kind, name)) {
    if (!(await isClean(relPath))) return true;
  }
  return false;
}
