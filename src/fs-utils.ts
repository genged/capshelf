import { lstatSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

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
  for (const delay of RM_RETRY_DELAYS_MS) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (
        !isErrno(err, "EACCES") &&
        !isErrno(err, "EPERM") &&
        !isErrno(err, "ENOTEMPTY")
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  await rm(path, { recursive: true, force: true });
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
