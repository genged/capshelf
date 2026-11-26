import { constants, existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { hashNamedContents } from "./content-hash";
import {
  assertRegularBlobEntries,
  lsTreeEntriesAtCommit,
  showAtCommit,
  isProjectWorkTreeRoot,
  projectVisibleFilesUnderPath,
} from "./git";
import type { GitFileMode, NamedFile } from "./merge-tree";
import { METADATA_SIDECAR } from "./metadata";
import type { CopyDirectoryItemKind } from "./master";
import {
  isMetadataSidecarPath,
  shaOfProjectVisibleItem,
  shaOfItemFiles,
} from "./master";
import { installedPath } from "./installed";
import { gitignoreVisibleFiles } from "./gitignore";
import type { ItemSnapshot, Scope } from "./promote-core";
import { PreconditionError } from "./errors";

export async function installedSnapshot(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  scope: Scope,
): Promise<ItemSnapshot | null> {
  const localPath = installedPath(project, kind, name);
  if (!existsSync(localPath)) return null;
  const relPath = relative(project, localPath);
  if (scope === "local" || !(await isProjectWorkTreeRoot(project))) {
    return await filesystemSnapshot(localPath);
  }
  // Hash the same Git-visible file list that the snapshot returns, without the
  // metadata sidecar, never a separately computed set. Promote re-derives the
  // sha as a TOCTOU guard, and a different input set would fail it for items
  // with ignored files.
  const files = await projectVisibleFilesUnderPath(project, relPath);
  return {
    source: "git-visible",
    localPath,
    sha: await shaOfItemFiles(
      localPath,
      files.filter((rel) => !isMetadataSidecarPath(rel)),
    ),
    files,
  };
}

/**
 * Local-scope installs sit in `.git/info/exclude`, so Git-visible hashing would
 * see no files.
 */
export async function shaOfInstalledForScope(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  scope: Scope,
): Promise<string | null> {
  const snapshot = await installedSnapshot(project, kind, name, scope);
  return snapshot?.sha ?? null;
}

export async function adoptionSnapshot(
  project: string,
  path: string,
  relPath: string,
  scope: Scope,
): Promise<ItemSnapshot> {
  if (scope === "local" || !(await isProjectWorkTreeRoot(project))) {
    return await filesystemSnapshot(path);
  }
  return {
    source: "git-visible",
    localPath: path,
    sha: await shaOfProjectVisibleItem(project, relPath),
    files: await projectVisibleFilesUnderPath(project, relPath),
  };
}

async function filesystemSnapshot(path: string): Promise<ItemSnapshot> {
  const files = await gitignoreVisibleFiles(path);
  return {
    source: "filesystem",
    localPath: path,
    // Exclude a root .capshelf.yml from the sha to avoid permanent false drift,
    // but keep it in `files` so copy-up carries an authored sidecar.
    sha: await shaOfItemFiles(
      path,
      files.filter((rel) => !isMetadataSidecarPath(rel)),
    ),
    files,
  };
}

export async function namedFilesFromInstalledSnapshot(
  snapshot: ItemSnapshot,
): Promise<NamedFile[]> {
  const files: NamedFile[] = [];
  for (const path of snapshot.files) {
    if (path === METADATA_SIDECAR) continue;
    const fullPath = join(snapshot.localPath, ...path.split("/"));
    const stats = await lstat(fullPath);
    if (!stats.isFile()) {
      throw new PreconditionError(
        `${snapshot.localPath} contains a non-regular file: ${path}; copy items support regular files only`,
      );
    }
    files.push({
      path,
      content: await readFile(fullPath),
      mode: fileMode(stats.mode),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function sidecarFromInstalledSnapshot(
  snapshot: ItemSnapshot,
): Promise<Buffer | null> {
  if (!snapshot.files.includes(METADATA_SIDECAR)) return null;
  return await readFile(join(snapshot.localPath, METADATA_SIDECAR));
}

export async function namedFilesAtCommit(
  dataRepo: string,
  repoRelPath: string,
  commit: string,
): Promise<NamedFile[]> {
  const prefix = `${repoRelPath}/`;
  const files: NamedFile[] = [];
  const entries = await lsTreeEntriesAtCommit(dataRepo, commit, repoRelPath);
  assertRegularBlobEntries(entries, repoRelPath);
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (path === METADATA_SIDECAR) continue;
    files.push({
      path,
      content: await showAtCommit(dataRepo, commit, entry.path),
      mode: entry.mode === "100755" ? "100755" : "100644",
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function sidecarAtCommit(
  dataRepo: string,
  repoRelPath: string,
  commit: string,
): Promise<Buffer | null> {
  const path = `${repoRelPath}/${METADATA_SIDECAR}`;
  const entries = await lsTreeEntriesAtCommit(dataRepo, commit, repoRelPath);
  assertRegularBlobEntries(entries, repoRelPath);
  const entry = entries.find((candidate) => candidate.path === path);
  return entry ? await showAtCommit(dataRepo, commit, path) : null;
}

export function shaOfNamedFiles(files: NamedFile[]): string {
  return hashNamedContents(
    files.map((file) => ({ name: file.path, content: file.content })),
  );
}

function fileMode(mode: number): GitFileMode {
  return (mode & constants.S_IXUSR) !== 0 ? "100755" : "100644";
}
