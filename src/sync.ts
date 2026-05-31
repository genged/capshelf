import { mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isIgnoredDotDirent } from "./dotfiles";
import { gitVisibleFilesUnderPath, isGitRepo } from "./git";
import type { MasterItem } from "./master";
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  installedPath,
} from "./installed";
import type { InstallMode } from "./paths";

export function targetDir(
  project: string,
  item: MasterItem,
  mode?: InstallMode,
): string {
  if (item.kind !== "skills") {
    throw new Error(`${item.kind}/${item.name} is a fragment item and has no install directory`);
  }
  return installedPath(project, item.kind, item.name, mode);
}

export async function copyRecursive(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (isIgnoredDotDirent(e)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyRecursive(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}

export async function replaceDirFromDir(src: string, dst: string): Promise<void> {
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  await copyRecursive(src, dst);
}

export async function replaceDirFromGitVisibleFiles(
  repo: string,
  relPath: string,
  src: string,
  dst: string,
): Promise<void> {
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  const files = await gitVisibleFilesUnderPath(repo, relPath);
  for (const rel of files) {
    const from = join(src, ...rel.split("/"));
    const to = join(dst, ...rel.split("/"));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

export async function copyItemIntoProject(
  project: string,
  item: MasterItem,
  mode?: InstallMode,
): Promise<string> {
  if (item.kind !== "skills") {
    throw new Error(`${item.kind}/${item.name} is a fragment item and cannot be copied into the project`);
  }
  const dst = targetDir(project, item, mode);
  assertCanMaterializeInstalled(project, item.kind, item.name, mode);
  const sourceRepo = sourceRepoForItem(item);
  if (await isGitRepo(sourceRepo)) {
    await replaceDirFromGitVisibleFiles(
      sourceRepo,
      item.repoRelPath,
      item.path,
      dst,
    );
  } else {
    await replaceDirFromDir(item.path, dst);
  }
  await ensureInstallAliases(project, item.kind, item.name, mode);
  return dst;
}

function sourceRepoForItem(item: MasterItem): string {
  return item.path.slice(0, item.path.length - item.repoRelPath.length - 1);
}
