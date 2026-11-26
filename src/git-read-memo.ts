import type { CheckAttrResult, GitTreeEntry } from "./git";

export class GitReadMemo {
  readonly shows = new Map<string, Buffer>();
  readonly commits = new Set<string>();
  readonly trees = new Map<string, GitTreeEntry[]>();
  readonly blobs = new Map<string, Buffer>();
  readonly batchPaths = new Map<string, string[]>();
  readonly batchTrees = new Map<string, GitTreeEntry[]>();
  /**
   * Answers are cached per path because one path's attributes do not depend on
   * the other paths in the query.
   */
  readonly attributesByPath = new Map<string, Map<string, CheckAttrResult[]>>();
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
