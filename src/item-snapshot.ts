import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ItemKind } from "./master";
import { shaOfGitVisibleItem, shaOfItem } from "./master";
import { installedPath, shaOfInstalled } from "./installed";
import { gitVisibleFilesUnderPath } from "./git";
import { isIgnoredDotDirent } from "./dotfiles";
import type { ItemSnapshot, Scope } from "./promote-core";

export async function installedSnapshot(
  project: string,
  kind: ItemKind,
  name: string,
  scope: Scope,
): Promise<ItemSnapshot | null> {
  const localPath = installedPath(project, kind, name);
  if (!existsSync(localPath)) return null;
  if (scope === "local") {
    return {
      source: "filesystem",
      localPath,
      sha: await shaOfItem(localPath),
      files: await itemFiles(localPath),
    };
  }
  const relPath = relative(project, localPath);
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
  if (scope === "local") {
    return {
      source: "filesystem",
      localPath: path,
      sha: await shaOfItem(path),
      files: await itemFiles(path),
    };
  }
  return {
    source: "git-visible",
    localPath: path,
    sha: await shaOfGitVisibleItem(project, relPath),
    files: await gitVisibleFilesUnderPath(project, relPath),
  };
}

async function itemFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(root, ...rel.split("/")) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnoredDotDirent(entry)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await walk("");
  out.sort();
  return out;
}
