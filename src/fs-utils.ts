import { lstatSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Narrow an unknown caught value to a Node errno error, optionally matching a
 * specific code (e.g. "ENOENT"). Replaces the hand-rolled
 * `err && typeof err === "object" && "code" in err && err.code === …` checks.
 */
export function isErrno(err: unknown, code?: string): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false;
  }
  return code === undefined || (err as { code?: unknown }).code === code;
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
