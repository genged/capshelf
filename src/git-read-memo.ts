import type { CheckAttrResult, GitTreeEntry } from "./git";

/** Immutable reads retained only by the caller that owns this instance. */
export class GitReadMemo {
  readonly shows = new Map<string, Buffer>();
  readonly commits = new Set<string>();
  readonly trees = new Map<string, GitTreeEntry[]>();
  readonly blobs = new Map<string, Buffer>();
  /** `check-attr` answers from a commit's own attributes. */
  readonly attributes = new Map<string, CheckAttrResult[]>();
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
