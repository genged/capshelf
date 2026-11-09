import { PreconditionError } from "./errors";
import { sourceIgnoreRules } from "./git";
import { gitTreeSource } from "./item-source";
import { type ItemKind, itemRepoRelPath } from "./master";
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
    gitTreeSource({
      repo: opts.dataRepo,
      kind: opts.kind,
      name: opts.name,
      commit: opts.commit,
    }),
    opts.kind,
    opts.name,
  );
  const mismatches = compareCandidateToCommit(opts.candidateFiles, pin.entries);
  if (mismatches.length > 0) {
    // Mismatch paths are item-relative; ignore rules match repo-relative
    // paths, and an anchored or item-local rule needs the full path.
    const itemRoot = itemRepoRelPath(opts.kind, opts.name);
    const rules = await sourceIgnoreRules(
      opts.dataRepo,
      mismatches
        .filter((entry) => entry.committed === null)
        .map((entry) => `${itemRoot}/${entry.path}`),
    );
    throw new PreconditionError(
      commitProofRefusalMessage(
        `${opts.kind}/${opts.name}`,
        mismatches,
        (path) => rules.get(`${itemRoot}/${path}`),
      ),
    );
  }
  return pin;
}
