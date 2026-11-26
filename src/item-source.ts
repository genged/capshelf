import type { LockEntry } from "./lock";
import { itemRepoRelPath } from "./master";
import type { ItemKind } from "./master";

export interface GitTreeSource {
  readonly kind: "git-tree";
  readonly repo: string;
  readonly commit: string;
  readonly itemRoot: string;
}

export interface BundledSource {
  readonly kind: "bundled";
  readonly sha: string;
}

export type ContentSource = GitTreeSource | BundledSource;

export type Ownership = "shelf" | "system";

/**
 * Both predicates accept null for a reporting path that cannot reach the item;
 * "not a git tree" and "unreachable" are different states.
 */
export function isGitTree(
  source: ContentSource | null,
): source is GitTreeSource {
  return source !== null && source.kind === "git-tree";
}

export function isBundled(
  source: ContentSource | null,
): source is BundledSource {
  return source !== null && source.kind === "bundled";
}

export function gitTreeSource(input: {
  repo: string;
  kind: ItemKind;
  name: string;
  commit: string;
  itemRoot?: string;
}): GitTreeSource {
  return {
    kind: "git-tree",
    repo: input.repo,
    commit: input.commit,
    itemRoot: input.itemRoot ?? itemRepoRelPath(input.kind, input.name),
  };
}

export function contentSourceFor(input: ContentSourceInput): ContentSource {
  return requireContentSource(
    contentSourceOrNull(input),
    input.kind,
    input.name,
  );
}

/**
 * Shares one refusal message with contentSourceFor so the user-facing text does
 * not depend on which function noticed.
 */
export function requireContentSource(
  source: ContentSource | null,
  kind: ItemKind,
  name: string,
): ContentSource {
  if (source === null) {
    throw new Error(
      `${kind}/${name} is a data item and needs a repository to read its content`,
    );
  }
  return source;
}

export interface ContentSourceInput {
  entry: LockEntry;
  kind: ItemKind;
  name: string;
  repo?: string | null;
  itemRoot?: string;
}

/**
 * Null means only "needs a repository and none is available"; bundled entries
 * still return a source so callers can tell owned bytes from unreachable ones.
 */
export function contentSourceOrNull(
  input: ContentSourceInput,
): ContentSource | null {
  if (input.entry.source === "system") {
    return { kind: "bundled", sha: input.entry.sha };
  }
  if (input.repo === undefined || input.repo === null) return null;
  return gitTreeSource({
    repo: input.repo,
    kind: input.kind,
    name: input.name,
    commit: input.entry.sourceCommit,
    ...(input.itemRoot !== undefined && { itemRoot: input.itemRoot }),
  });
}

/**
 * Ownership is derived from the entry's `source` field rather than stored,
 * because both lock documents hold both populations.
 */
export function ownershipFor(entry: LockEntry): Ownership {
  return entry.source === "system" ? "system" : "shelf";
}

export function sameContentSource(
  left: ContentSource,
  right: ContentSource,
): boolean {
  if (isGitTree(left) && isGitTree(right)) {
    return (
      left.repo === right.repo &&
      left.commit === right.commit &&
      left.itemRoot === right.itemRoot
    );
  }
  // A bundled source always resolves to the running binary's tree, so any two
  // select the same content.
  return !isGitTree(left) && !isGitTree(right);
}
