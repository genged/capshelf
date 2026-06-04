import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { ItemKind } from "./master";
import { shaOfGitVisibleItem, shaOfItem, shaOfItemFiles } from "./master";
import { installedPath, shaOfInstalled } from "./installed";
import { gitVisibleFilesUnderPath, isGitRepo } from "./git";
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
  if (scope === "local" || !(await isGitRepo(project))) {
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

export async function adoptionSnapshot(
  project: string,
  path: string,
  relPath: string,
  scope: Scope,
): Promise<ItemSnapshot> {
  if (scope === "local" || !(await isGitRepo(project))) {
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
    sha: await shaOfItemFiles(path, files),
    files,
  };
}
