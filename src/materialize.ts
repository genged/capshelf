import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { existsSync } from "node:fs";
import type { LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  parseLockKey,
  installedPath,
  shaOfInstalled,
} from "./installed";
import type { ItemSource } from "./installed";
import type { ItemKind } from "./master";
import { findSystemItem, installSystemItem, shaOfSystemItem } from "./bundled";
import { lsTreeEntriesAtCommit, showAtCommit } from "./git";
import type { GitTreeEntry } from "./git";
import { hasIgnoredDotSegment } from "./dotfiles";
import { runtimeWarningsForItem } from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import { missingSourceCommitMessage } from "./upstream-check";

export type MaterializeAction =
  | "reconciled"
  | "would-reconcile"
  | "already-current"
  | "kept-local";

export interface MaterializeResult {
  key: string;
  source: ItemSource;
  kind: ItemKind;
  name: string;
  action: MaterializeAction;
  path: string;
  sha: string | null;
  currentSha?: string | null;
  plannedSha?: string;
  dryRun?: true;
  message?: string;
  runtimeWarnings?: RuntimeWarning[];
}

interface MaterializeOptions {
  project: string;
  dataRepo?: string;
  manifest?: Manifest;
  key: string;
  entry: LockEntry;
  ignoreLocal?: boolean;
  dryRun?: boolean;
}

export async function materializeLockEntry(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const { source, kind, name } = parseLockKey(opts.key);
  const dst = installedPath(opts.project, kind, name);
  const runtimeWarnings = runtimeWarningsForItem(opts.project, kind, name);

  if (opts.entry.source !== source) {
    throw new Error(
      `lock key ${opts.key} source does not match entry source ${opts.entry.source}`,
    );
  }

  if (
    opts.entry.source === "data" &&
    opts.entry.local === true &&
    !opts.ignoreLocal
  ) {
    return {
      key: opts.key,
      source,
      kind,
      name,
      action: "kept-local",
      path: dst,
      sha: await shaOfInstalled(opts.project, kind, name),
      message: opts.entry.localReason,
      ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    };
  }

  const before = await shaOfInstalled(opts.project, kind, name);
  if (opts.entry.source === "data") {
    if (!opts.dataRepo) {
      throw new Error(`data repo is required to apply ${kind}/${name}`);
    }
    if (opts.dryRun) {
      assertCanMaterializeInstalled(opts.project, kind, name);
      const sourceSha = await shaOfDataAtCommit(
        opts.dataRepo,
        opts.manifest,
        kind,
        name,
        opts.entry.sourceCommit,
      );
      if (sourceSha !== opts.entry.sha) {
        throw new Error(
          `source ${kind}/${name} at ${opts.entry.sourceCommit} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
        );
      }
    } else {
      await materializeDataAtCommit(
        opts.project,
        opts.dataRepo,
        opts.manifest,
        kind,
        name,
        opts.entry.sourceCommit,
      );
    }
  } else {
    const item = findSystemItem(name);
    if (!item || item.kind !== kind) {
      throw new Error(`system item no longer bundled: ${kind}/${name}`);
    }
    if (opts.dryRun) {
      assertCanMaterializeInstalled(opts.project, kind, name);
      const sourceSha = await shaOfSystemItem(item);
      if (sourceSha !== opts.entry.sha) {
        throw new Error(
          `bundled ${kind}/${name} hashes to ${sourceSha}, but lock expects ${opts.entry.sha}`,
        );
      }
    } else {
      await installSystemItem(opts.project, item);
    }
  }

  const after = opts.dryRun
    ? before
    : await shaOfInstalled(opts.project, kind, name);
  if (after !== opts.entry.sha) {
    if (opts.dryRun) {
      return {
        key: opts.key,
        source,
        kind,
        name,
        action: "would-reconcile",
        path: dst,
        sha: before,
        currentSha: before,
        plannedSha: opts.entry.sha,
        dryRun: true,
        ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
      };
    }
    throw new Error(
      `materialized ${kind}/${name} at ${after ?? "(missing)"}, but lock expects ${opts.entry.sha}`,
    );
  }

  return {
    key: opts.key,
    source,
    kind,
    name,
    action: before === after ? "already-current" : "reconciled",
    path: dst,
    sha: after,
    ...(opts.dryRun && {
      currentSha: before,
      plannedSha: opts.entry.sha,
      dryRun: true as const,
    }),
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
  };
}

async function shaOfDataAtCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<string> {
  const repoRelPath = `${kind}/${name}`;
  const files = await materializableFilesAtCommit(
    dataRepo,
    manifest,
    commit,
    repoRelPath,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const rel = posix.relative(repoRelPath, file.path);
    hasher.update(rel);
    hasher.update("\0");
    try {
      hasher.update(await showAtCommit(dataRepo, commit, file.path));
    } catch {
      throwMissingCommit(dataRepo, manifest, commit);
    }
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}

async function materializeDataAtCommit(
  project: string,
  dataRepo: string,
  manifest: Manifest | undefined,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<void> {
  const repoRelPath = `${kind}/${name}`;
  const files = await materializableFilesAtCommit(
    dataRepo,
    manifest,
    commit,
    repoRelPath,
  );

  const dst = installedPath(project, kind, name);
  assertCanMaterializeInstalled(project, kind, name);
  if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });

  for (const file of files) {
    const rel = posix.relative(repoRelPath, file.path);
    const out = join(dst, ...rel.split("/"));
    await mkdir(dirname(out), { recursive: true });
    try {
      await writeFile(out, await showAtCommit(dataRepo, commit, file.path));
    } catch {
      throwMissingCommit(dataRepo, manifest, commit);
    }
    const mode = fileModeFromGit(file.mode);
    if (mode !== null) await chmod(out, mode);
  }
  await ensureInstallAliases(project, kind, name);
}

async function materializableFilesAtCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  commit: string,
  repoRelPath: string,
): Promise<GitTreeEntry[]> {
  let entries: GitTreeEntry[];
  try {
    entries = await lsTreeEntriesAtCommit(dataRepo, commit, repoRelPath);
  } catch {
    throwMissingCommit(dataRepo, manifest, commit);
  }

  const files = entries
    .filter((file) => {
      const rel = posix.relative(repoRelPath, file.path);
      return (
        file.type === "blob" &&
        rel &&
        !rel.startsWith("..") &&
        !hasIgnoredDotSegment(rel)
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    throw new Error(`${repoRelPath} has no materializable files at ${commit}`);
  }

  return files;
}

function throwMissingCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  commit: string,
): never {
  if (manifest) {
    throw new Error(missingSourceCommitMessage(dataRepo, commit, manifest));
  }
  throw new Error(`data repo at ${dataRepo} does not contain commit ${commit}`);
}

function fileModeFromGit(mode: string): number | null {
  switch (mode) {
    case "100644":
      return 0o644;
    case "100755":
      return 0o755;
    default:
      return null;
  }
}
