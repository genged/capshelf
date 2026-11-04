import type { CheckAttrResult, GitTreeEntry } from "./git";

/** Immutable reads retained only by the caller that owns this instance. */
export class GitReadMemo {
  readonly shows = new Map<string, Buffer>();
  readonly commits = new Set<string>();
  readonly trees = new Map<string, GitTreeEntry[]>();
  readonly blobs = new Map<string, Buffer>();
  /**
   * The literal paths of the items that a command will read at one commit.
   * A command registers a commit only when two or more items share it. Then
   * one `ls-tree` over all their paths answers each item's tree read, and one
   * `check-attr` over all their files answers each item's attribute query.
   */
  readonly batchPaths = new Map<string, string[]>();
  /** The one `ls-tree -r -t -z` listing of the registered paths at a commit. */
  readonly batchTrees = new Map<string, GitTreeEntry[]>();
  /**
   * `check-attr` answers from a commit's own attributes, by path. The answer
   * for one path does not depend on the other paths in the query.
   */
  readonly attributesByPath = new Map<string, Map<string, CheckAttrResult[]>>();
  /** `log -1 <head> -- <pathspecs>` answers from a fixed `head`. */
  readonly lastTouching = new Map<string, string | null>();
}

export function gitObjectReadKey(
  repo: string,
  object: string,
  args: readonly string[] = [],
): string | undefined {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)) return undefined;
  return JSON.stringify([repo, object, args]);
}
