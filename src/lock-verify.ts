import { posix } from "node:path";
import { hashNamedContents } from "./content-hash";
import { needsEqual } from "./lock";
import type { Lock } from "./lock";
import { parseLockKey } from "./installed";
import {
  assertRegularBlobEntries,
  commitExists,
  lsTreeEntriesAtCommit,
  showAtCommit,
} from "./git";
import type { Manifest } from "./manifest";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";
import type {
  CopyDirectoryItemKind,
  FragmentItemKind,
  ItemKind,
} from "./master";
import { itemTreeEntriesAtCommit, sourcePinDigest } from "./pin";
import { loadCommittedItemNeeds } from "./metadata";
import { shaOfSubagentAtCommit } from "./subagents";

export async function verifyDataLockEntries(
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<void> {
  for (const [key, entry] of Object.entries(lock.items)) {
    if (entry.source !== "data") continue;
    const parsed = parseLockKey(key);
    const relPath = itemRepoRelPath(parsed.kind, parsed.name);
    if (entry.sourcePinDigest !== undefined) {
      // Lock version 4: one `ls-tree` and a digest — no blob is read, and no
      // working-tree state participates.
      const digest = sourcePinDigest(
        await itemTreeEntriesAtCommit(
          dataRepo,
          parsed.kind,
          parsed.name,
          entry.sourceCommit,
        ).catch(() => {
          throw new Error(
            missingSourceCommitMessage(dataRepo, entry.sourceCommit, manifest),
          );
        }),
      );
      if (digest !== entry.sourcePinDigest) {
        throw new Error(
          `source ${relPath} at ${entry.sourceCommit} pins to ${digest}, but lock expects ${entry.sourcePinDigest}`,
        );
      }
    } else {
      const sha = await legacyShaAtCommit(
        dataRepo,
        manifest,
        parsed.kind,
        parsed.name,
        entry.sourceCommit,
      );
      if (sha !== entry.sha) {
        throw new Error(
          `source ${relPath} at ${entry.sourceCommit} hashes to ${sha}, but lock expects ${entry.sha}`,
        );
      }
    }
    if (entry.needs != null && entry.needsSourceCommit != null) {
      const needsSourceCommit = entry.needsSourceCommit;
      if (!(await commitExists(dataRepo, needsSourceCommit))) {
        throw new Error(
          missingSourceCommitMessage(dataRepo, needsSourceCommit, manifest),
        );
      }
      const metadata = await loadCommittedItemNeeds(
        dataRepo,
        { kind: parsed.kind, name: parsed.name },
        needsSourceCommit,
      );
      if (!needsEqual(metadata.needs, entry.needs)) {
        throw new Error(
          `needs for ${relPath} at ${needsSourceCommit} do not match the lock snapshot`,
        );
      }
    }
  }
}

/**
 * The lock version 2/3 content hash of an item at a commit, per kind.
 *
 * Version 4 no longer uses this to decide anything, but `lock migrate` needs
 * it once, to audit the old `sha` before discarding it: an entry whose legacy
 * hash disagrees with the commit it names is exactly the failure this whole
 * design exists to repair, and the migration reports it as
 * `repaired-legacy-identity` rather than silently dropping the evidence.
 */
export async function legacyShaAtCommit(
  dataRepo: string,
  manifest: Manifest,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<string> {
  if (isFragmentItemKind(kind)) {
    return await shaOfFragmentAtCommit(dataRepo, manifest, kind, name, commit);
  }
  if (isCopyDirectoryItemKind(kind)) {
    return await shaOfDataAtCommit(dataRepo, manifest, kind, name, commit);
  }
  if (isCopyTargetFileItemKind(kind)) {
    return await shaOfSubagentAtCommit("", dataRepo, name, commit);
  }
  throw new Error(`lock verification has no strategy for ${kind}/${name}`);
}

async function shaOfFragmentAtCommit(
  dataRepo: string,
  manifest: Manifest,
  kind: FragmentItemKind,
  name: string,
  commit: string,
): Promise<string> {
  const present: string[] = [];
  for (const relPath of allCanonicalItemRelPaths(kind, name)) {
    try {
      await showAtCommit(dataRepo, commit, relPath);
      present.push(relPath);
    } catch {
      // Target-specific fragment files are optional.
    }
  }
  if (present.length === 0) {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  return hashNamedContents(
    await Promise.all(
      present.map(async (relPath) => ({
        name: relPath,
        content: await showAtCommit(dataRepo, commit, relPath),
      })),
    ),
  );
}

async function shaOfDataAtCommit(
  dataRepo: string,
  manifest: Manifest,
  kind: CopyDirectoryItemKind,
  name: string,
  commit: string,
): Promise<string> {
  const relPath = itemRepoRelPath(kind, name);
  let entries: Awaited<ReturnType<typeof lsTreeEntriesAtCommit>>;
  try {
    entries = await lsTreeEntriesAtCommit(dataRepo, commit, relPath);
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  assertRegularBlobEntries(entries, relPath);

  // Reduce to item-relative paths. hashNamedContents sorts by name in the same
  // code-unit order as shaOfItemFiles (add-time hashing over
  // gitVisibleFilesUnderPath), so the recorded sha reproduces here. Sorting by
  // repo-relative path with localeCompare instead — as this once did — reorders
  // multi-file items (e.g. SKILL.md vs café.md) and rejects valid rebinds.
  const rels = entries
    .filter((file) => {
      const rel = posix.relative(relPath, file.path);
      return (
        file.type === "blob" &&
        rel &&
        !rel.startsWith("..") &&
        !hasIgnoredDotSegment(rel) &&
        // The metadata sidecar is catalog data, never materialized and never
        // included in the at-commit sha; keep this consistent with
        // materialize.ts so rebind (set-data) doesn't reject valid locks.
        !isMetadataSidecarPath(rel)
      );
    })
    .map((file) => posix.relative(relPath, file.path));

  if (rels.length === 0) {
    throw new Error(`${relPath} has no materializable files at ${commit}`);
  }

  try {
    return hashNamedContents(
      await Promise.all(
        rels.map(async (rel) => ({
          name: rel,
          content: await showAtCommit(
            dataRepo,
            commit,
            posix.join(relPath, rel),
          ),
        })),
      ),
    );
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
}
