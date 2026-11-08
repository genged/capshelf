import { lstatSync } from "node:fs";
import { chmod, lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Narrow a caught value to a Node errno error, optionally matching a specific
 * code (e.g. "ENOENT"). Every Node filesystem API rejects with an `Error`
 * instance that carries `code`, so an `Error` with the field is the contract.
 */
export function isErrno(
  err: unknown,
  code?: string,
): err is NodeJS.ErrnoException {
  if (!(err instanceof Error) || !("code" in err)) return false;
  return code === undefined || err.code === code;
}

/** lstat a path, returning null when it does not exist and rethrowing otherwise. */
export function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

const RM_RETRY_DELAYS_MS = [150, 400];

/**
 * Remove a file tree, retrying briefly when the failure may be transient.
 * The runtime already retries ENOTEMPTY internally on most platforms, but on
 * macOS a directory that a concurrent process repopulates mid-delete (or
 * otherwise refuses to empty) surfaces as EACCES/EPERM naming the top-level
 * path (nodejs/node#57095), which is never retried. A short backoff lets a
 * transient writer finish; a persistent denial still throws the last error.
 */
export async function rmTreeWithRetries(path: string): Promise<void> {
  let madeWritable = false;
  for (const delay of RM_RETRY_DELAYS_MS) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const denied = isErrno(err, "EACCES") || isErrno(err, "EPERM");
      if (!denied && !isErrno(err, "ENOTEMPTY")) throw err;
      if (denied && !madeWritable) {
        madeWritable = true;
        await makeFoldersWritable(path);
        continue;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }
  await rm(path, { recursive: true, force: true });
}

/**
 * Give the owner full access to each folder in a tree that is about to be
 * deleted. A delete must write a folder to remove its entries, and some tools
 * make their folders read-only, for example the Go module cache (0555). This
 * does not follow symbolic links. A folder that this process cannot change
 * stays as it is, and the next delete reports the error.
 */
async function makeFoldersWritable(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) {
    await chmod(path, (info.mode & 0o7777) | 0o700).catch(() => {});
  }
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return;
  }
  for (const name of names) await makeFoldersWritable(join(path, name));
}

let atomicWriteCounter = 0;

/**
 * Write a file atomically: write to a uniquely-named temp file in the same
 * directory, then rename it into place. rename(2) within a directory is atomic
 * on POSIX (and replaces the destination on Windows too), so a crash, SIGKILL,
 * or ENOSFC mid-write can never leave a truncated file — a reader sees either
 * the old contents or the complete new contents. Used for every persistent
 * state file (lockfiles, manifest, local config, generated agent config,
 * materialized item content). The caller must ensure the directory exists (the
 * temp file lands beside the target, so it shares the target's filesystem).
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const tmp = `${path}.${process.pid}.${atomicWriteCounter++}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
