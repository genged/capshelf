import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { $ } from "bun";
import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import type { ItemKind } from "./master";
import type { ItemSource } from "./installed";
import { installedPath } from "./installed";
import { findSystemItem } from "./bundled";
import { assertGitAvailable, lsTreeAtCommit, showAtCommit } from "./git";
import { gitVisibleFilesUnderPath, isGitRepo } from "./git";
import { planSettingsOutput } from "./settings";
import { hasIgnoredDotSegment, isIgnoredDotDirent } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";

type LocalDiffState =
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "drifted_and_upstream_dirty";

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

export interface StatusDiff {
  item: string;
  path: string;
  text: string;
}

export function shouldShowLocalDiff(state: string): state is LocalDiffState {
  return (
    state === "drifted_local" ||
    state === "drifted_and_update" ||
    state === "missing_installed" ||
    state === "drifted_and_upstream_dirty"
  );
}

export async function buildStatusDiff(
  opts: StatusDiffOptions,
): Promise<StatusDiff | null> {
  const { row } = opts;
  if (!shouldShowLocalDiff(row.state)) return null;

  if (row.kind === "settings") {
    if (!opts.dataRepo) return null;
    const item = `${row.source}/settings/(merged)`;
    const plan = await planSettingsOutput({
      project: opts.project,
      dataRepo: opts.dataRepo,
      manifest: opts.manifest,
      oldLock: opts.lock,
      nextLock: opts.lock,
    });
    const text = await unifiedDiff(
      `${plan.path} (current)`,
      `${plan.path} (locked)`,
      plan.currentText ?? "",
      plan.plannedText,
    );
    return text ? { item, path: plan.path, text } : null;
  }

  const item = `${row.source}/${row.kind}/${row.name}`;
  const currentFiles = await readInstalledFiles(
    opts.project,
    installedPath(opts.project, row.kind, row.name),
  );
  const expectedFiles = await expectedFilesForRow(opts);
  const text = await diffFileMaps(currentFiles, expectedFiles, item);
  return text
    ? {
        item,
        path: installedPath(opts.project, row.kind, row.name),
        text,
      }
    : null;
}

async function expectedFilesForRow(
  opts: StatusDiffOptions,
): Promise<Map<string, string>> {
  const { row } = opts;
  if (row.source === "system") {
    const item = findSystemItem(row.name);
    if (!item || item.kind !== row.kind) return new Map();
    return new Map(item.files.map((file) => [file.relPath, file.content]));
  }

  if (!opts.dataRepo) return new Map();
  if (!row.sourceCommit) return new Map();

  const repoRelPath = `${row.kind}/${row.name}`;
  let files: string[];
  try {
    files = await lsTreeAtCommit(opts.dataRepo, row.sourceCommit, repoRelPath);
  } catch {
    throw new Error(
      missingSourceCommitMessage(opts.dataRepo, row.sourceCommit, opts.manifest),
    );
  }
  const out = new Map<string, string>();
  for (const file of files) {
    const rel = posix.relative(repoRelPath, file);
    if (!rel || rel.startsWith("..") || hasIgnoredDotSegment(rel)) continue;
    out.set(
      rel,
      (await showExpectedFile(opts, row.sourceCommit, file)).toString("utf-8"),
    );
  }
  return out;
}

async function showExpectedFile(
  opts: StatusDiffOptions,
  commit: string,
  file: string,
): Promise<Buffer> {
  if (!opts.dataRepo) throw new Error("data repo is required");
  try {
    return await showAtCommit(opts.dataRepo, commit, file);
  } catch {
    throw new Error(missingSourceCommitMessage(opts.dataRepo, commit, opts.manifest));
  }
}

async function readInstalledFiles(
  project: string,
  root: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  if (await isGitRepo(project)) {
    const relRoot = relative(project, root);
    if (relRoot && !relRoot.startsWith("..")) {
      for (const rel of await gitVisibleFilesUnderPath(project, relRoot)) {
        out.set(rel, await readFile(join(root, ...rel.split("/")), "utf-8"));
      }
      return out;
    }
  }

  async function walk(relDir: string): Promise<void> {
    const abs = relDir ? join(root, ...relDir.split("/")) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnoredDotDirent(entry)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const child = join(root, ...rel.split("/"));
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) out.set(rel, await readFile(child, "utf-8"));
    }
  }

  await walk("");
  return out;
}

async function diffFileMaps(
  current: Map<string, string>,
  expected: Map<string, string>,
  item: string,
): Promise<string> {
  const files = [...new Set([...current.keys(), ...expected.keys()])].sort();
  const parts: string[] = [];
  for (const file of files) {
    const currentText = current.get(file) ?? "";
    const expectedText = expected.get(file) ?? "";
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
    return normalizeDiffHeaders(text, currentPath, expectedPath, fromLabel, toLabel);
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
