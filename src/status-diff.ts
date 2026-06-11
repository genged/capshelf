import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { $ } from "bun";
import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import { isMetadataSidecarPath } from "./master";
import type { ItemKind } from "./master";
import type { ItemSource } from "./installed";
import { installedPath } from "./installed";
import { findSystemItem } from "./bundled";
import { assertGitAvailable, lsTreeAtCommit, showAtCommit } from "./git";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";
import { gitignoreVisibleFiles } from "./gitignore";
import {
  allCanonicalFragmentRelPaths,
  isFragmentKind,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
} from "./fragments";

type LocalDiffState =
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "missing_output"
  | "drifted_and_upstream_dirty"
  | "output_drift"
  | "source_dirty"
  | "source_dirty_and_output_drift";

interface DiffableStatusRow {
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: string;
  sourceCommit?: string;
}

interface StatusDiffOptions {
  project: string;
  dataRepo: string | null;
  manifest: Manifest;
  lock: Lock;
  row: DiffableStatusRow;
}

interface CopyItemFilesOptions {
  project: string;
  dataRepo: string | null;
  manifest: Manifest;
  source: ItemSource;
  kind: ItemKind;
  name: string;
  sourceCommit?: string;
}

export interface StatusDiff {
  item: string;
  path: string;
  text: string;
}

type FileMap = Map<string, Buffer>;

export function shouldShowLocalDiff(state: string): state is LocalDiffState {
  return (
    state === "drifted_local" ||
    state === "drifted_and_update" ||
    state === "missing_installed" ||
    state === "missing_output" ||
    state === "drifted_and_upstream_dirty" ||
    state === "output_drift" ||
    state === "source_dirty" ||
    state === "source_dirty_and_output_drift"
  );
}

export async function buildStatusDiff(
  opts: StatusDiffOptions,
): Promise<StatusDiff | null> {
  const { row } = opts;
  if (!shouldShowLocalDiff(row.state)) return null;

  if (isFragmentKind(row.kind)) {
    if (!opts.dataRepo) return null;
    if (!row.sourceCommit) return null;
    const entry = {
      source: "data" as const,
      sha: "",
      sourceCommit: row.sourceCommit,
      appliedAt: "",
    };
    const targets = await lockedFragmentTargetsForItem(
      opts.dataRepo,
      row.kind,
      row.name,
      entry,
      opts.manifest,
    );
    const parts: string[] = [];
    let firstPath = "";
    for (const target of targets) {
      const plan = await planFragmentOutput({
        project: opts.project,
        dataRepo: opts.dataRepo,
        manifest: opts.manifest,
        oldLock: opts.lock,
        nextLock: opts.lock,
        target,
      });
      firstPath ||= plan.path;
      const text = await unifiedDiff(
        `${plan.path} (current)`,
        `${plan.path} (locked)`,
        plan.currentText ?? "",
        plan.plannedText ?? "",
      );
      if (text) parts.push(text);
    }
    if (
      row.state === "source_dirty" ||
      row.state === "source_dirty_and_output_drift"
    ) {
      const sourceDiff = await dataRepoDiff(
        opts.dataRepo,
        allCanonicalFragmentRelPaths(row.kind, row.name),
      );
      if (sourceDiff) parts.push(sourceDiff);
    }
    const text = parts.join("\n");
    return text
      ? { item: `${row.source}/${row.kind}/${row.name}`, path: firstPath, text }
      : null;
  }

  const item = `${row.source}/${row.kind}/${row.name}`;
  const expectedFiles = await expectedFilesForRow(opts);
  if (!expectedFiles) return null;
  const currentFiles = await readInstalledFiles(
    installedPath(opts.project, row.kind, row.name),
    expectedFiles,
  );
  const text = await diffFileMaps(currentFiles, expectedFiles, item);
  return text
    ? {
        item,
        path: installedPath(opts.project, row.kind, row.name),
        text,
      }
    : null;
}

export async function currentCopyItemSha(
  opts: CopyItemFilesOptions,
): Promise<string | null> {
  const root = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(root)) return null;

  const expectedFiles = await expectedFilesForCopyItem(opts);
  const currentFiles = await readInstalledFiles(
    root,
    expectedFiles ?? new Map(),
  );
  return shaOfFileMap(currentFiles);
}

async function dataRepoDiff(
  dataRepo: string,
  relPaths: string[],
): Promise<string> {
  await assertGitAvailable();
  const result = await $`git -C ${dataRepo} diff HEAD -- ${relPaths}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || "git diff failed");
  }
  const parts = [result.stdout.toString()].filter((text) => text.length > 0);
  for (const relPath of await untrackedDataRepoFiles(dataRepo, relPaths)) {
    const untracked =
      await $`git -C ${dataRepo} diff --no-index -- /dev/null ${relPath}`
        .quiet()
        .nothrow();
    if (untracked.exitCode !== 0 && untracked.exitCode !== 1) {
      throw new Error(untracked.stderr.toString().trim() || "git diff failed");
    }
    const text = untracked.stdout.toString();
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

async function untrackedDataRepoFiles(
  dataRepo: string,
  relPaths: string[],
): Promise<string[]> {
  const result =
    await $`git -C ${dataRepo} ls-files -z --others --exclude-standard -- ${relPaths}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || "git ls-files failed");
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
}

async function expectedFilesForRow(
  opts: StatusDiffOptions,
): Promise<FileMap | null> {
  return await expectedFilesForCopyItem({
    project: opts.project,
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    source: opts.row.source,
    kind: opts.row.kind,
    name: opts.row.name,
    sourceCommit: opts.row.sourceCommit,
  });
}

async function expectedFilesForCopyItem(
  opts: CopyItemFilesOptions,
): Promise<FileMap | null> {
  if (opts.source === "system") {
    const item = findSystemItem(opts.name);
    if (!item || item.kind !== opts.kind) return null;
    return new Map(
      item.files.map((file) => [
        file.relPath,
        Buffer.from(file.content, "utf-8"),
      ]),
    );
  }

  if (!opts.dataRepo) return null;
  if (!opts.sourceCommit) return null;

  const repoRelPath = `${opts.kind}/${opts.name}`;
  let files: string[];
  try {
    files = await lsTreeAtCommit(opts.dataRepo, opts.sourceCommit, repoRelPath);
  } catch {
    throw new Error(
      missingSourceCommitMessage(
        opts.dataRepo,
        opts.sourceCommit,
        opts.manifest,
      ),
    );
  }
  const out: FileMap = new Map();
  for (const file of files) {
    const rel = posix.relative(repoRelPath, file);
    if (
      !rel ||
      rel.startsWith("..") ||
      hasIgnoredDotSegment(rel) ||
      // A committed metadata sidecar is catalog data, not locked content; it
      // must not appear as a "missing" file in status --diff.
      isMetadataSidecarPath(rel)
    ) {
      continue;
    }
    out.set(rel, await showExpectedFile(opts, opts.sourceCommit, file));
  }
  return out;
}

async function showExpectedFile(
  opts: { dataRepo: string | null; manifest: Manifest },
  commit: string,
  file: string,
): Promise<Buffer> {
  if (!opts.dataRepo) throw new Error("data repo is required");
  try {
    return await showAtCommit(opts.dataRepo, commit, file);
  } catch {
    throw new Error(
      missingSourceCommitMessage(opts.dataRepo, commit, opts.manifest),
    );
  }
}

async function readInstalledFiles(
  root: string,
  expectedFiles: FileMap,
): Promise<FileMap> {
  const out: FileMap = new Map();
  if (!existsSync(root)) return out;

  // A project-side root .capshelf.yml is never managed content: keep it out
  // of the file-map hash (currentCopyItemSha) and of status --diff output.
  const files = new Set(
    (await gitignoreVisibleFiles(root)).filter(
      (rel) => !isMetadataSidecarPath(rel),
    ),
  );
  for (const rel of expectedFiles.keys()) files.add(rel);
  for (const rel of [...files].sort()) {
    const file = join(root, ...rel.split("/"));
    if (existsSync(file) && (await lstat(file)).isFile()) {
      out.set(rel, await readFile(file));
    }
  }
  return out;
}

async function diffFileMaps(
  current: FileMap,
  expected: FileMap,
  item: string,
): Promise<string> {
  const files = [...new Set([...current.keys(), ...expected.keys()])].sort();
  const parts: string[] = [];
  for (const file of files) {
    const currentText = current.get(file)?.toString("utf-8") ?? "";
    const expectedText = expected.get(file)?.toString("utf-8") ?? "";
    const text = await unifiedDiff(
      `${file} (current)`,
      `${file} (locked ${item})`,
      currentText,
      expectedText,
    );
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function shaOfFileMap(files: FileMap): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const rel of [...files.keys()].sort()) {
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(files.get(rel)!);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}

export async function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  fromText: string,
  toText: string,
): Promise<string> {
  if (fromText === toText) return "";
  await assertGitAvailable();

  const dir = await mkdtemp(join(tmpdir(), "capshelf-diff-"));
  const currentPath = join(dir, "current");
  const expectedPath = join(dir, "locked");
  try {
    await writeFile(currentPath, fromText);
    await writeFile(expectedPath, toText);
    const result =
      await $`git diff --no-index --unified=3 -- ${currentPath} ${expectedPath}`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) return "";
    if (result.exitCode !== 1) {
      throw new Error(result.stderr.toString().trim() || "git diff failed");
    }
    const text = result.stdout.toString();
    return normalizeDiffHeaders(
      text,
      currentPath,
      expectedPath,
      fromLabel,
      toLabel,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function normalizeDiffHeaders(
  text: string,
  currentPath: string,
  expectedPath: string,
  fromLabel: string,
  toLabel: string,
): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) continue;
    if (line.startsWith("index ")) continue;
    if (line === `--- ${currentPath}` || line.startsWith(`--- a/`)) {
      out.push(`--- ${fromLabel}`);
    } else if (line === `+++ ${expectedPath}` || line.startsWith(`+++ b/`)) {
      out.push(`+++ ${toLabel}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}
