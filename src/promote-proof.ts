import { PreconditionError } from "./errors";
import type { ItemKind } from "./master";
import type { NamedFile } from "./merge-tree";
import {
  commitProofRefusalMessage,
  compareProjectToCommit,
  pinItemAtCommit,
} from "./pin";
import type { PinnedSource } from "./pin";

/**
 * PIN-11 for a **generated candidate**: capshelf built a tree from the project
 * (or from a merge), committed it, and must now show that what landed in the
 * commit is what it meant to publish.
 *
 * This applies to copy items, subagents, and merge results. It deliberately
 * does **not** apply to fragment promotion, where the user's own edits are
 * already in the data repo worktree and `promote` commits them in place: there
 * is no project snapshot to compare, so applying the rule there would refuse a
 * legitimate operation rather than catch anything.
 */
export async function assertCommittedTreeEqualsProject(opts: {
  dataRepo: string;
  kind: ItemKind;
  name: string;
  commit: string;
  projectFiles: readonly NamedFile[];
}): Promise<PinnedSource> {
  const pin = await pinItemAtCommit(
    opts.dataRepo,
    opts.kind,
    opts.name,
    opts.commit,
  );
  const mismatches = compareProjectToCommit(opts.projectFiles, pin.entries);
  if (mismatches.length > 0) {
    throw new PreconditionError(
      commitProofRefusalMessage(`${opts.kind}/${opts.name}`, mismatches),
    );
  }
  return pin;
}
