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
 * On macOS a directory repopulated mid-delete surfaces as EACCES/EPERM on the
 * top-level path, which the runtime never retries (nodejs/node#57095), so retry
 * with a short backoff.
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
 * Deleting needs write access to folders, and some tools make theirs read-only
 * (e.g. Go module cache, 0555); symlinks are not followed.
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

const ATOMIC_WRITE_NAME_ATTEMPTS = 64;

/**
 * The caller must confine the path to a root or give an exemption reason, so
 * writes cannot bypass scope checks by accident. The data goes to a sibling temp file opened with O_EXCL, retrying under a new
 * name on EEXIST so a planted entry or symlink is never followed. The temp file
 * is then renamed over the target, so a reader sees the old or the complete new
 * contents, never a truncated file.
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
 * A plain `mkdir -p` through a symlinked parent would create folders outside
 * the root, so check scope first.
 */
export async function ensureDir(
  dir: string,
  scope: MutationScope,
): Promise<void> {
  await assertInScope(scope, dir);
  await mkdir(dir, { recursive: true });
}
