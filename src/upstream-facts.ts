import { findMasterItemByRef } from "./item-ref";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  shaOfGitVisibleItem,
} from "./master";
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
  /** worktree content sha of the data-repo item; null when dirty or missing */
  upstreamSha: string | null;
  /** true when the data-repo item path has uncommitted changes */
  upstreamDirty: boolean;
  /** Last commit affecting the accepted item content model. */
  sourceCommit: string | null;
}

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
): Promise<UpstreamFacts> {
  const masterItem = await findMasterItemByRef(dataRepo, { kind, name });
  if (!masterItem) {
    return { upstreamSha: null, upstreamDirty: false, sourceCommit: null };
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
