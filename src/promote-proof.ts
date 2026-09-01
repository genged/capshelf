import { PreconditionError } from "./errors";
import type { ItemKind } from "./master";
import type { NamedFile } from "./merge-tree";
import {
  commitProofRefusalMessage,
  compareCandidateToCommit,
  pinItemAtCommit,
} from "./pin";
import type { PinnedSource } from "./pin";

/**
 * PIN-11 for a selected candidate. The candidate can come from a project
 * snapshot, a merge, or canonical fragment source bytes. The commit must hold
 * exactly that candidate.
 */
export async function assertCommittedTreeEqualsCandidate(opts: {
  dataRepo: string;
  kind: ItemKind;
  name: string;
  commit: string;
  candidateFiles: readonly NamedFile[];
}): Promise<PinnedSource> {
  const pin = await pinItemAtCommit(
    opts.dataRepo,
    opts.kind,
    opts.name,
    opts.commit,
  );
  const mismatches = compareCandidateToCommit(opts.candidateFiles, pin.entries);
  if (mismatches.length > 0) {
    throw new PreconditionError(
      commitProofRefusalMessage(`${opts.kind}/${opts.name}`, mismatches),
    );
  }
  return pin;
}
