import { posix } from "node:path";
import type { Lock } from "./lock";
import { parseLockKey } from "./installed";
import { lsTreeEntriesAtCommit, showAtCommit } from "./git";
import type { Manifest } from "./manifest";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";
import {
  allCanonicalItemRelPaths,
  isFragmentItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";

export async function verifyDataLockEntries(
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<void> {
  for (const [key, entry] of Object.entries(lock.items)) {
    if (entry.source !== "data") continue;
    const parsed = parseLockKey(key);
    const relPath = itemRepoRelPath(parsed.kind, parsed.name);
    const sha = isFragmentItemKind(parsed.kind)
      ? await shaOfFragmentAtCommit(
          dataRepo,
          manifest,
          parsed.kind,
          parsed.name,
          entry.sourceCommit,
        )
      : await shaOfDataAtCommit(
          dataRepo,
          manifest,
          relPath,
          entry.sourceCommit,
        );
    if (sha !== entry.sha) {
      throw new Error(
        `source ${relPath} at ${entry.sourceCommit} hashes to ${sha}, but lock expects ${entry.sha}`,
      );
    }
  }
}

async function shaOfFragmentAtCommit(
  dataRepo: string,
  manifest: Manifest,
  kind: Exclude<ReturnType<typeof parseLockKey>["kind"], "skills">,
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
  const hasher = new Bun.CryptoHasher("sha256");
  for (const relPath of present.sort()) {
    hasher.update(relPath);
    hasher.update("\0");
    hasher.update(await showAtCommit(dataRepo, commit, relPath));
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}

async function shaOfDataAtCommit(
  dataRepo: string,
  manifest: Manifest,
  relPath: string,
  commit: string,
): Promise<string> {
  let entries: Awaited<ReturnType<typeof lsTreeEntriesAtCommit>>;
  try {
    entries = await lsTreeEntriesAtCommit(dataRepo, commit, relPath);
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }

  // Reduce to item-relative paths and sort by that path in default (code-unit)
  // order — this must exactly mirror shaOfItemFiles (add-time hashing over
  // gitVisibleFilesUnderPath), which sorts item-relative names with a plain
  // .sort(). Sorting by the repo-relative path with localeCompare instead would
  // reorder multi-file items (e.g. SKILL.md before/after café.md) and make
  // rebind (set-data) reject valid locks.
  const files = entries
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
    .map((file) => posix.relative(relPath, file.path))
    .sort();

  if (files.length === 0) {
    throw new Error(`${relPath} has no materializable files at ${commit}`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  for (const rel of files) {
    hasher.update(rel);
    hasher.update("\0");
    try {
      hasher.update(
        await showAtCommit(dataRepo, commit, posix.join(relPath, rel)),
      );
    } catch {
      throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
    }
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}
