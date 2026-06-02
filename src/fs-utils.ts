import { lstatSync } from "node:fs";

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
