/**
 * The two questions `LockEntry.source` used to answer at once.
 *
 * `ContentSource` says where an item's bytes come from. `Ownership` says who
 * owns the content and who owns the record. Two populations differ on both
 * axes at the same time, so one field could answer both; a third population
 * separates them, and every site that reads `entry.source === "data"` to decide
 * a content question would route that population into the bundled-item branch.
 *
 * Both values are derived in memory at the read boundary. Nothing new is
 * written to a lock file, and identity is unchanged.
 */
import type { LockEntry } from "./lock";
import { itemRepoRelPath } from "./master";
import type { ItemKind } from "./master";

/** Bytes in a git tree: one repository, one commit, one root. */
export interface GitTreeSource {
  readonly kind: "git-tree";
  readonly repo: string;
  readonly commit: string;
  /** Repository-relative, POSIX-separated root of the item. */
  readonly itemRoot: string;
}

/** Bytes in the running CLI binary. */
export interface BundledSource {
  readonly kind: "bundled";
  readonly sha: string;
}

export type ContentSource = GitTreeSource | BundledSource;

/**
 * Who owns the content and who owns the record.
 *
 * `shelf`: the data repo owns the content, capshelf owns the record.
 * `system`: the CLI binary owns both.
 */
export type Ownership = "shelf" | "system";

/**
 * Both predicates accept null, which is what a reporting path holds when it
 * cannot reach the item at all. "Not a git tree" and "unreachable" are
 * different states, so each has its own answer.
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

/**
 * A git-tree source at an explicit commit, for a caller that selects one
 * rather than reading one from a lock entry — `add`, `update`, `promote`, and
 * `share` all pin a commit they just chose.
 *
 * `itemRoot` defaults to the canonical layout, which is where every item lives
 * today. The item root was always a field of the data model; it stayed
 * invisible while `itemRepoRelPath` could derive it for every item.
 */
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

/**
 * The content source a lock entry selects.
 *
 * `entry.source` is read here and nowhere else afterwards: a consumer asks
 * `isGitTree(source)` instead. A data entry with no repository is a programmer
 * error, which is what `materialize.ts` used to report from a distance through
 * an ambient `dataRepo` argument that had to agree with the entry.
 */
export function contentSourceFor(input: ContentSourceInput): ContentSource {
  const source = contentSourceOrNull(input);
  if (source === null) {
    throw new Error(
      `${input.kind}/${input.name} is a data item and needs a repository to read its content`,
    );
  }
  return source;
}

export interface ContentSourceInput {
  entry: LockEntry;
  kind: ItemKind;
  name: string;
  /** The resolved repository, when the entry needs one. */
  repo?: string | null;
  /** Overrides the canonical layout. Nothing supplies one yet. */
  itemRoot?: string;
}

/**
 * The same source for a reporting path, which must degrade rather than fail.
 *
 * Null means one thing only: the entry reads from a repository and none is
 * available. A bundled entry still returns a source, so a caller can still tell
 * "the CLI owns these bytes" from "I cannot reach them".
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
 * Ownership is derived, never stored. It is a function of which document holds
 * the record and the record's own `source` field. `capshelf.lock.json` and
 * `local.lock.json` hold both populations, and `source` tells them apart.
 */
export function ownershipFor(entry: LockEntry): Ownership {
  return entry.source === "system" ? "system" : "shelf";
}

/** True when two sources resolve to the same tree, so one read serves both. */
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
  // A bundled source always resolves to the running binary's tree, so two of
  // them select the same content whatever the entries record.
  return !isGitTree(left) && !isGitTree(right);
}
