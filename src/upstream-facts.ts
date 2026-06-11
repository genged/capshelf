import { findMasterItemByRef } from "./item-ref";
import { isFragmentItemKind, shaOfGitVisibleItem } from "./master";
import type { FragmentItemKind, ItemKind } from "./master";
import { isPathClean } from "./git";
import { allCanonicalFragmentRelPaths, shaOfFragmentItem } from "./fragments";

export interface UpstreamFacts {
  /** worktree content sha of the data-repo item; null when dirty or missing */
  upstreamSha: string | null;
  /** true when the data-repo item path has uncommitted changes */
  upstreamDirty: boolean;
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
  if (!masterItem) return { upstreamSha: null, upstreamDirty: false };
  const upstreamDirty = isFragmentItemKind(kind)
    ? await fragmentSourceDirty(dataRepo, kind, name)
    : !(await isPathClean(dataRepo, masterItem.repoRelPath));
  const upstreamSha = upstreamDirty
    ? null
    : isFragmentItemKind(kind)
      ? await shaOfFragmentItem(dataRepo, kind, name)
      : await shaOfGitVisibleItem(dataRepo, masterItem.repoRelPath);
  return { upstreamSha, upstreamDirty };
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
