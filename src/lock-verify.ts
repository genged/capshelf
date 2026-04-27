import { posix } from "node:path";
import type { Lock } from "./lock";
import { parseLockKey } from "./installed";
import { lsTreeEntriesAtCommit, showAtCommit } from "./git";
import type { Manifest } from "./manifest";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";

export async function verifyDataLockEntries(
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
): Promise<void> {
  for (const [key, entry] of Object.entries(lock.items)) {
    if (entry.source !== "data") continue;
    const parsed = parseLockKey(key);
    const relPath = `${parsed.kind}/${parsed.name}`;
    const sha = await shaOfDataAtCommit(
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

async function shaOfDataAtCommit(
  dataRepo: string,
  manifest: Manifest,
  relPath: string,
  commit: string,
): Promise<string> {
  let files;
  try {
    files = (await lsTreeEntriesAtCommit(dataRepo, commit, relPath))
      .filter((file) => {
        const rel = posix.relative(relPath, file.path);
        return (
          file.type === "blob" &&
          rel &&
          !rel.startsWith("..") &&
          !hasIgnoredDotSegment(rel)
        );
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }

  if (files.length === 0) {
    throw new Error(`${relPath} has no materializable files at ${commit}`);
  }

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const rel = posix.relative(relPath, file.path);
    hasher.update(rel);
    hasher.update("\0");
    try {
      hasher.update(await showAtCommit(dataRepo, commit, file.path));
    } catch {
      throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
    }
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}
