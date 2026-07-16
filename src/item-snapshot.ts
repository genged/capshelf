import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { ItemKind } from "./master";
import {
  isMetadataSidecarPath,
  shaOfGitVisibleItem,
  shaOfItem,
  shaOfItemFiles,
} from "./master";
import { installedPath, shaOfInstalled } from "./installed";
import { gitVisibleFilesUnderPath, isGitWorkTreeRoot } from "./git";
import { gitignoreVisibleFiles } from "./gitignore";
import type { ItemSnapshot, Scope } from "./promote-core";

export async function installedSnapshot(
  project: string,
  kind: ItemKind,
  name: string,
  scope: Scope,
): Promise<ItemSnapshot | null> {
  const localPath = installedPath(project, kind, name);
  if (!existsSync(localPath)) return null;
  const relPath = relative(project, localPath);
  if (scope === "local" || !(await isGitWorkTreeRoot(project))) {
    return await filesystemSnapshot(localPath);
  }
  return {
    source: "git-visible",
    localPath,
    sha:
      (await shaOfInstalled(project, kind, name)) ??
      (await shaOfItem(localPath)),
    files: await gitVisibleFilesUnderPath(project, relPath),
  };
}

/**
 * Scope-aware installed-content sha. Local-scope installs are deliberately
 * listed in `.git/info/exclude`, so the default Git-visible hashing in
 * `shaOfInstalled` would see an empty file list; this delegates to
 * `installedSnapshot` so the scope branching and hashing conventions stay
 * defined in one place.
 */
export async function shaOfInstalledForScope(
  project: string,
  kind: ItemKind,
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
  if (scope === "local" || !(await isGitWorkTreeRoot(project))) {
    return await filesystemSnapshot(path);
  }
  return {
    source: "git-visible",
    localPath: path,
    sha: await shaOfGitVisibleItem(project, relPath),
    files: await gitVisibleFilesUnderPath(project, relPath),
  };
}

async function filesystemSnapshot(path: string): Promise<ItemSnapshot> {
  const files = await gitignoreVisibleFiles(path);
  return {
    source: "filesystem",
    localPath: path,
    // The sha must exclude a project-side root .capshelf.yml like every other
    // hashing path, or promote/share/move would record a tainted lock sha for
    // local-scope items and non-git projects (permanent false drift). The
    // unfiltered `files` list is kept: copy-up callers must carry an authored
    // sidecar to the data repo.
    sha: await shaOfItemFiles(
      path,
      files.filter((rel) => !isMetadataSidecarPath(rel)),
    ),
    files,
  };
}
