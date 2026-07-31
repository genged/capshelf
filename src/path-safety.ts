import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PreconditionError } from "./errors";

export async function assertNoSymlinkAncestors(
  root: string,
  relPath: string,
): Promise<void> {
  const parts =
    relPath === "." ? [] : relPath.split("/").filter((part) => part.length > 0);
  if (
    isAbsolute(relPath) ||
    relPath.includes("\\") ||
    parts.includes(".") ||
    parts.includes("..")
  ) {
    throw new PreconditionError(`unsafe repository path "${relPath}"`);
  }
  let current = await realpath(root);
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new PreconditionError(
          `${relPath} has symlink component "${part}"`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function assertNoSymlinkAncestorsSync(
  root: string,
  relPath: string,
): void {
  const parts =
    relPath === "." ? [] : relPath.split("/").filter((part) => part.length > 0);
  let current = realpathSync(root);
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new PreconditionError(
          `${relPath} has symlink component "${part}"`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function assertRealPathOutsideRoot(
  root: string,
  candidate: string,
  message: string,
): Promise<void> {
  const rootReal = await realpath(root);
  const candidateReal = await resolveThroughNearestExisting(candidate);
  const rel = relative(rootReal, candidateReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new PreconditionError(message);
  }
}

async function resolveThroughNearestExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw error;
      missing.push(
        cursor.slice(parent.length + (parent.endsWith("/") ? 0 : 1)),
      );
      cursor = parent;
    }
  }
}
