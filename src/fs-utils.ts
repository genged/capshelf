import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isErrno } from "./errno";
import { PreconditionError } from "./errors";
import { assertInScope, type MutationScope } from "./path-safety";

export { isErrno };

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
export async function rmTreeWithRetries(
  path: string,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, path);
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

/** How many temp names `atomicWriteFile` tries before it gives up. */
const ATOMIC_WRITE_NAME_ATTEMPTS = 64;

/**
 * Write a file atomically: write to a uniquely-named temp file in the same
 * directory, then rename it into place. rename(2) within a directory is atomic
 * on POSIX (and replaces the destination on Windows too), so a crash, SIGKILL,
 * or ENOSFC mid-write can never leave a truncated file — a reader sees either
 * the old contents or the complete new contents. Used for every persistent
 * state file (lockfiles, manifest, local config, generated agent config,
 * materialized item content). The caller must ensure the directory exists (the
 * temp file lands beside the target, so it shares the target's filesystem).
 * `scope` is required: the path must stay inside the scope's root, or the
 * caller names a reason for the exemption.
 *
 * The temp file is created with `O_CREAT | O_EXCL` ("wx"). The open fails
 * with EEXIST when an entry of that name exists, and a symlink counts as an
 * entry, so the write never follows a planted link. On EEXIST a new name with
 * a random part is tried, and the planted entry stays as it is. The temp name
 * is a sibling of `path`, so the parent folders are the ones that
 * `assertInScope` checked. Cleanup removes only the temp file that this call
 * created.
 */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, path);
  let tmp = "";
  let handle: FileHandle | null = null;
  for (let attempt = 0; handle === null; attempt++) {
    const random = attempt === 0 ? "" : `.${randomBytes(4).toString("hex")}`;
    tmp = `${path}.${process.pid}.${atomicWriteCounter++}${random}.tmp`;
    try {
      handle = await open(tmp, "wx");
    } catch (err) {
      if (!isErrno(err, "EEXIST")) throw err;
      if (attempt + 1 >= ATOMIC_WRITE_NAME_ATTEMPTS) {
        throw new PreconditionError(
          `cannot create a temp file beside ${path}: ${ATOMIC_WRITE_NAME_ATTEMPTS} names are taken`,
          { cause: err },
        );
      }
    }
  }
  try {
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Create `dir` and its parents after the scope check. A plain `mkdir -p`
 * through a symlinked parent would create folders outside the root.
 */
export async function ensureDir(
  dir: string,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, dir);
  await mkdir(dir, { recursive: true });
}
