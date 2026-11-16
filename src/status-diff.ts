import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Lock } from "./lock";
import type { Manifest } from "./manifest";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isMetadataSidecarPath,
} from "./master";
import type { CopyDirectoryItemKind, ItemKind } from "./master";
import { installedPath } from "./installed";
import type { RowSource } from "./status-core";
import { remoteCacheState } from "./remote-cache";
import { remoteTreeSource } from "./remote-discovery";
import { contentSourceOrNull, gitTreeSource, isGitTree } from "./item-source";
import type { ContentSource } from "./item-source";
import { findSystemItem } from "./bundled";
import {
  assertRegularBlobEntries,
  catFileBlobs,
  isolatedNoIndexDiff,
  sourceRead,
  sourceReadText,
  literalPathspec,
  lsTreeEntriesForPathspecs,
} from "./git";
import type { GitTreeEntry } from "./git";
import type { GitReadMemo } from "./git-read-memo";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";
import { gitignoreVisibleFiles } from "./gitignore";
import {
  allCanonicalFragmentRelPaths,
  isFragmentKind,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
} from "./fragments";
import { subagentSourceAtCommit, subagentSourcesAtCommit } from "./subagents";
import { isErrno, lstatOrNull } from "./fs-utils";
import { currentSourceCommit } from "./pin";

interface DiffableStatusRow {
  scope?: "project" | "local";
  source: RowSource;
  remote?: { upstream: string; subpath: string };
  kind: ItemKind;
  name: string;
  state: string;
  /**
   * The pin the row was built from. A remote row is in neither capshelf lock,
   * so this is the only place its locked identity can be read.
   */
  lockedSha?: string;
  sourceCommit?: string;
  currentSha?: string | null;
  upstreamSha?: string | null;
  upstreamDirty?: boolean;
}

interface StatusDiffOptions {
  project: string;
  dataRepo: string | null;
  manifest: Manifest;
  lock: Lock;
  row: DiffableStatusRow;
  view?: StatusDiffView;
  fragmentPlanner?: typeof planFragmentOutput;
  memo?: GitReadMemo;
}

interface CopyDirectoryFilesOptions {
  project: string;
  source: ContentSource | null;
  manifest: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  memo?: GitReadMemo;
}

export interface StatusDiff {
  item: string;
  path: string;
  view: Exclude<StatusDiffView, "all">;
  from: DiffEndpoint;
  to: DiffEndpoint;
  text: string | null;
  unavailableReason?: string;
  note?: string;
}

export type StatusDiffView = "installed" | "upstream" | "all";

export interface DiffEndpoint {
  role: "locked" | "installed" | "upstream";
  sha: string | null;
  sourceCommit: string | null;
}

interface FileSide {
  content: Buffer;
  executable: boolean;
}

type FileMap = Map<string, FileSide>;

const DEV_NULL = "/dev/null";

export async function buildStatusDiff(
  opts: StatusDiffOptions,
): Promise<StatusDiff | null> {
  const { row } = opts;
  const view: "installed" | "upstream" =
    opts.view === "upstream" ? "upstream" : "installed";
  if (
    view === "upstream" &&
    row.state !== "update_available" &&
    row.state !== "drifted_and_update" &&
    row.state !== "missing_upstream" &&
    row.state !== "missing_source_commit" &&
    row.state !== "drifted_and_upstream_dirty" &&
    row.state !== "upstream_dirty"
  ) {
    return null;
  }

  const entry = opts.lock.items[`${row.source}/${row.kind}/${row.name}`];
  // A remote row is in neither capshelf lock, so the lock lookup misses; use
  // the row's own pin.
  const lockedSha =
    row.source === "remote"
      ? (row.lockedSha ?? null)
      : entry
        ? (("sourcePinDigest" in entry ? entry.sourcePinDigest : entry.sha) ??
          null)
        : null;
  const lockedCommit = row.sourceCommit ?? null;
  const base = {
    item: `${row.scope ? `${row.scope}/` : ""}${row.source}/${row.kind}/${row.name}`,
    view,
    from: {
      role: "locked" as const,
      sha: lockedSha,
      sourceCommit: lockedCommit,
    },
  };

  if (view === "upstream") {
    // Reading a remote's current content needs a fetch, which `status --diff`
    // never does, so the view is unavailable rather than wrong.
    if (row.source === "remote") {
      return {
        ...base,
        path: installedPath(opts.project, row.kind, row.name),
        to: { role: "upstream", sha: null, sourceCommit: null },
        text: null,
        unavailableReason:
          "an upstream diff for a remote skill needs a fetch; run capshelf status --check-upstream first",
      };
    }
    if (row.source !== "data" || !isCopyDirectoryItemKind(row.kind)) {
      return {
        ...base,
        path: installedPath(opts.project, row.kind, row.name),
        to: { role: "upstream", sha: null, sourceCommit: null },
        text: null,
        unavailableReason:
          "upstream diff is not available for this item strategy",
      };
    }
    if (!opts.dataRepo || !row.sourceCommit) {
      return {
        ...base,
        path: installedPath(opts.project, row.kind, row.name),
        to: { role: "upstream", sha: null, sourceCommit: null },
        text: null,
        unavailableReason: !opts.dataRepo
          ? "data repo is unavailable"
          : "locked source commit is missing",
      };
    }
    let upstreamCommit: string;
    let lockedFiles: FileMap;
    let upstreamFiles: FileMap;
    try {
      upstreamCommit = await currentSourceCommit(
        opts.dataRepo,
        row.kind,
        row.name,
      );
      lockedFiles = (await expectedFilesForRow(opts)) ?? new Map();
      upstreamFiles =
        (await expectedFilesForCopyItem({
          project: opts.project,
          source: gitTreeSource({
            repo: opts.dataRepo,
            kind: row.kind,
            name: row.name,
            commit: upstreamCommit,
          }),
          manifest: opts.manifest,
          kind: row.kind,
          name: row.name,
          memo: opts.memo,
        })) ?? new Map();
    } catch (error) {
      return {
        ...base,
        path: installedPath(opts.project, row.kind, row.name),
        to: { role: "upstream", sha: null, sourceCommit: null },
        text: null,
        unavailableReason:
          error instanceof Error ? error.message : String(error),
      };
    }
    const text = await diffFileMaps(
      upstreamFiles,
      lockedFiles,
      base.item,
      "upstream",
      lockedCommit,
      upstreamCommit,
    );
    return {
      ...base,
      path: installedPath(opts.project, row.kind, row.name),
      to: {
        role: "upstream",
        sha: row.upstreamSha ?? null,
        sourceCommit: upstreamCommit,
      },
      text,
      ...(row.upstreamDirty === true && {
        note: "upstream diff uses committed HEAD; uncommitted data-repo changes are excluded",
      }),
    };
  }

  if (isFragmentKind(row.kind)) {
    if (!opts.dataRepo) return null;
    if (!row.sourceCommit) return null;
    const entry = {
      source: "data" as const,
      sha: "",
      sourceCommit: row.sourceCommit,
      appliedAt: "",
      needs: null,
      needsSourceCommit: null,
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
      const plan = await (opts.fragmentPlanner ?? planFragmentOutput)({
        project: opts.project,
        dataRepo: opts.dataRepo,
        manifest: opts.manifest,
        oldLock: opts.lock,
        nextLock: opts.lock,
        target,
        memo: opts.memo,
      });
      firstPath ||= plan.path;
      const text = await unifiedDiff(
        `${plan.path} (locked)`,
        `${plan.path} (current)`,
        plan.plannedText ?? "",
        plan.currentText ?? "",
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
      ? {
          ...base,
          path: firstPath,
          to: {
            role: "installed",
            sha: row.currentSha ?? null,
            sourceCommit: null,
          },
          text,
        }
      : null;
  }
  if (isCopyTargetFileItemKind(row.kind)) {
    if (!opts.dataRepo || !row.sourceCommit) return null;
    const sources = await subagentSourcesAtCommit(
      opts.project,
      opts.dataRepo,
      row.name,
      row.sourceCommit,
      opts.memo,
    );
    const parts: string[] = [];
    for (const source of sources) {
      const expected = await subagentSourceAtCommit(
        opts.dataRepo,
        row.name,
        row.sourceCommit,
        source.relPath,
        opts.memo,
      );
      const currentStat = lstatOrNull(source.outputPath);
      const current =
        currentStat?.isFile() && !currentStat.isSymbolicLink()
          ? await readFile(source.outputPath)
          : Buffer.alloc(0);
      const text = await unifiedDiffBytes(
        `${source.outputPath} (locked)`,
        `${source.outputPath} (current)`,
        expected,
        current,
      );
      if (text) parts.push(text);
    }
    const text = parts.join("\n");
    return text
      ? {
          ...base,
          path: sources[0]!.outputPath,
          to: {
            role: "installed",
            sha: row.currentSha ?? null,
            sourceCommit: null,
          },
          text,
        }
      : null;
  }
  if (!isCopyDirectoryItemKind(row.kind)) {
    throw new Error(`no status diff strategy for ${row.kind}/${row.name}`);
  }

  const item = `${row.source}/${row.kind}/${row.name}`;
  let expectedFiles: FileMap | null;
  try {
    expectedFiles = await expectedFilesForRow(opts);
  } catch (error) {
    return {
      ...base,
      path: installedPath(opts.project, row.kind, row.name),
      to: {
        role: "installed",
        sha: row.currentSha ?? null,
        sourceCommit: null,
      },
      text: null,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!expectedFiles) return null;
  const currentFiles = await readInstalledFiles(
    installedPath(opts.project, row.kind, row.name),
    expectedFiles.keys(),
  );
  const text = await diffFileMaps(
    currentFiles,
    expectedFiles,
    item,
    opts.view === undefined ? "current" : "installed",
    opts.view === undefined ? null : lockedCommit,
    null,
  );
  return text
    ? {
        ...base,
        path: installedPath(opts.project, row.kind, row.name),
        to: {
          role: "installed",
          sha: row.currentSha ?? null,
          sourceCommit: null,
        },
        text,
      }
    : null;
}

export async function currentCopyDirectoryItemSha(
  opts: CopyDirectoryFilesOptions,
): Promise<string | null> {
  const root = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(root)) return null;

  // Ordinary status needs only the locked path set, so reserve blob reads for
  // `status --diff`.
  const expectedPaths = await expectedFilePathsForCopyItem(opts);
  const currentFiles = await readInstalledFiles(root, expectedPaths ?? []);
  return shaOfFileMap(currentFiles);
}

export async function copyDirectoryModeDrifted(
  opts: CopyDirectoryFilesOptions,
): Promise<boolean> {
  const root = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(root)) return false;

  const expected = await expectedModesForCopyItem(opts);
  if (expected === null) return false;
  for (const [rel, executable] of expected) {
    const path = join(root, ...rel.split("/"));
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
    if (!info.isFile()) return true;
    if (((info.mode & 0o111) !== 0) !== executable) return true;
  }
  return false;
}

/**
 * `status` runs no program the data repo names, and `git diff HEAD` would start
 * `filter.<driver>.clean`, so both sides are read as bytes and diffed in an
 * attribute-free directory.
 */
async function dataRepoDiff(
  dataRepo: string,
  relPaths: string[],
): Promise<string> {
  const committed = await committedSources(dataRepo, relPaths);
  const staged = await stagedSourcePaths(dataRepo, relPaths);
  const untracked = await untrackedDataRepoFiles(dataRepo, relPaths);
  // A staged-but-uncommitted file is absent from HEAD and from `ls-files
  // --others`, so only the index reveals it.
  const paths = [
    ...new Set([...committed.keys(), ...staged.keys(), ...untracked]),
  ].sort();
  const parts: string[] = [];
  for (const relPath of paths) {
    const before = committed.get(relPath) ?? null;
    const current = await worktreeSource(dataRepo, relPath);
    const text = await unifiedDiff(
      `${relPath} (HEAD)`,
      `${relPath} (current)`,
      before === null ? null : before.content,
      current === null ? null : current.content,
      {
        ...(before !== null && { fromExecutable: before.executable }),
        ...(current !== null && { toExecutable: current.executable }),
      },
    );
    if (text) parts.push(text);
    // `git rm --cached` leaves the file on disk, so neither compared side
    // changes and the staged removal would render as nothing.
    if (before !== null && current !== null && !staged.has(relPath)) {
      parts.push(
        `${relPath}: staged for deletion; the file is still in the working tree`,
      );
    }
  }
  return parts.join("\n");
}

interface SourceSide {
  content: string;
  executable: boolean;
}

/**
 * Read via `cat-file`, which runs no smudge filter and consults no working
 * tree.
 */
async function committedSources(
  dataRepo: string,
  relPaths: string[],
): Promise<Map<string, SourceSide>> {
  const entries = (
    await lsTreeEntriesForPathspecs(
      dataRepo,
      "HEAD",
      relPaths.map(literalPathspec),
    )
  ).filter((entry) => entry.type === "blob");
  const blobs = await catFileBlobs(
    dataRepo,
    entries.map((entry) => entry.object),
  );
  return new Map(
    entries.map((entry) => [
      entry.path,
      {
        content: (blobs.get(entry.object) ?? Buffer.alloc(0)).toString("utf-8"),
        executable: entry.mode === "100755",
      },
    ]),
  );
}

/**
 * `ls-files --stage` reads only the index, so no clean filter runs; unmerged
 * stages don't matter since only paths are used.
 */
async function stagedSourcePaths(
  dataRepo: string,
  relPaths: string[],
): Promise<Set<string>> {
  const out = await sourceReadText(dataRepo, [
    "ls-files",
    "--stage",
    "-z",
    "--",
    ...relPaths.map(literalPathspec),
  ]);
  const paths = new Set<string>();
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const match = /^\d{6} [0-9a-f]+ \d\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`unexpected git ls-files output: ${record}`);
    paths.add(match[1]!);
  }
  return paths;
}

async function worktreeSource(
  dataRepo: string,
  relPath: string,
): Promise<SourceSide | null> {
  const path = join(dataRepo, ...relPath.split("/"));
  const stat = lstatOrNull(path);
  if (stat?.isFile() !== true) return null;
  return {
    content: await readFile(path, "utf-8"),
    executable: (Number(stat.mode) & 0o111) !== 0,
  };
}

async function untrackedDataRepoFiles(
  dataRepo: string,
  relPaths: string[],
): Promise<string[]> {
  const result = await sourceRead(dataRepo, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
    "--",
    ...relPaths.map(literalPathspec),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
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
  if (!isCopyDirectoryItemKind(opts.row.kind)) {
    throw new Error(
      `${opts.row.kind}/${opts.row.name} does not use copy-directory status files`,
    );
  }
  return await expectedFilesForCopyItem({
    project: opts.project,
    source: lockedContentSource(opts),
    manifest: opts.manifest,
    kind: opts.row.kind,
    name: opts.row.name,
    memo: opts.memo,
  });
}

function lockedContentSource(opts: StatusDiffOptions): ContentSource | null {
  const { row } = opts;
  // A remote row is in neither capshelf lock, so a lock lookup would silently
  // report no diff; its bytes are in the clone cache.
  if (row.source === "remote") {
    if (row.remote === undefined || row.sourceCommit === undefined) return null;
    const cache = remoteCacheState(row.remote.upstream);
    if (!cache.present) return null;
    return remoteTreeSource(cache.path, row.sourceCommit, row.remote.subpath);
  }
  const entry = opts.lock.items[`${row.source}/${row.kind}/${row.name}`];
  if (entry === undefined) return null;
  return contentSourceOrNull({
    entry,
    kind: row.kind,
    name: row.name,
    repo: opts.dataRepo,
  });
}

async function expectedFilesForCopyItem(
  opts: CopyDirectoryFilesOptions,
): Promise<FileMap | null> {
  if (opts.source === null) return null;
  if (!isGitTree(opts.source)) {
    const item = findSystemItem(opts.name);
    if (!item || item.kind !== opts.kind) return null;
    return new Map(
      item.files.map((file) => [
        file.relPath,
        {
          content: Buffer.from(file.content, "utf-8"),
          executable: false,
        },
      ]),
    );
  }

  const source = opts.source;
  const files = await expectedFileEntriesForCopyItem(opts);
  if (!files) return null;
  // `git show <commit>:<path>` prints blobs raw (no smudge filter, textconv
  // only with `--textconv`), so one `cat-file --batch` yields the same bytes.
  let blobs: Map<string, Buffer>;
  try {
    // Items are read once, so bytes aren't memoized; peak memory follows the
    // largest item.
    blobs = await catFileBlobs(
      source.repo,
      files.map((file) => file.object),
      opts.memo,
      false,
    );
  } catch {
    throw new Error(
      missingSourceCommitMessage(source.repo, source.commit, opts.manifest),
    );
  }
  const out: FileMap = new Map();
  for (const expected of files) {
    const content = blobs.get(expected.object);
    if (content === undefined) {
      throw new Error(
        missingSourceCommitMessage(source.repo, source.commit, opts.manifest),
      );
    }
    out.set(expected.rel, { content, executable: expected.executable });
  }
  return out;
}

async function expectedFilePathsForCopyItem(
  opts: CopyDirectoryFilesOptions,
): Promise<string[] | null> {
  return (
    (await expectedFileEntriesForCopyItem(opts))?.map((entry) => entry.rel) ??
    null
  );
}

async function expectedFileEntriesForCopyItem(
  opts: CopyDirectoryFilesOptions,
): Promise<Array<{ rel: string; executable: boolean; object: string }> | null> {
  if (opts.source === null) return null;
  if (!isGitTree(opts.source)) {
    const item = findSystemItem(opts.name);
    if (!item || item.kind !== opts.kind) return null;
    return item.files.map((file) => ({
      rel: file.relPath,
      executable: false,
      object: "",
    }));
  }

  const { repo, commit, itemRoot } = opts.source;
  let entries: GitTreeEntry[];
  try {
    entries = await lsTreeEntriesForPathspecs(
      repo,
      commit,
      [literalPathspec(itemRoot)],
      { memo: opts.memo },
    );
  } catch {
    throw new Error(missingSourceCommitMessage(repo, commit, opts.manifest));
  }
  assertRegularBlobEntries(entries, itemRoot);
  return entries
    .map((entry) => ({
      rel: posix.relative(itemRoot, entry.path),
      executable: entry.mode === "100755",
      object: entry.object,
    }))
    .filter(
      ({ rel }) =>
        rel.length > 0 &&
        !rel.startsWith("..") &&
        !hasIgnoredDotSegment(rel) &&
        // A committed metadata sidecar is catalog data, not locked content, so
        // it stays out of hashes and diffs.
        !isMetadataSidecarPath(rel),
    );
}

async function expectedModesForCopyItem(
  opts: CopyDirectoryFilesOptions,
): Promise<Map<string, boolean> | null> {
  const files = await expectedFileEntriesForCopyItem(opts);
  return files === null
    ? null
    : new Map(files.map(({ rel, executable }) => [rel, executable]));
}

async function readInstalledFiles(
  root: string,
  expectedPaths: Iterable<string>,
): Promise<FileMap> {
  const out: FileMap = new Map();
  if (!existsSync(root)) return out;

  // A project-side root .capshelf.yml is never managed content, so it stays out
  // of hashes and diffs.
  const files = new Set(
    (await gitignoreVisibleFiles(root)).filter(
      (rel) => !isMetadataSidecarPath(rel),
    ),
  );
  for (const rel of expectedPaths) files.add(rel);
  for (const rel of [...files].sort()) {
    const path = join(root, ...rel.split("/"));
    if (existsSync(path)) {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      out.set(rel, {
        content: await readFile(path),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  }
  return out;
}

async function diffFileMaps(
  current: FileMap,
  expected: FileMap,
  item: string,
  view: "installed" | "upstream" | "current" = "installed",
  lockedCommit: string | null = null,
  targetCommit: string | null = null,
): Promise<string> {
  const files = [...new Set([...current.keys(), ...expected.keys()])].sort();
  const parts: string[] = [];
  for (const file of files) {
    const currentFile = current.get(file) ?? null;
    const expectedFile = expected.get(file) ?? null;
    const text = await unifiedDiffBytes(
      `${file} (locked${lockedCommit ? ` ${lockedCommit.slice(0, 7)}` : ` ${item}`})`,
      `${file} (${view}${targetCommit ? ` ${targetCommit.slice(0, 7)}` : ""})`,
      expectedFile?.content ?? null,
      currentFile?.content ?? null,
      {
        ...(expectedFile !== null && {
          fromExecutable: expectedFile.executable,
        }),
        ...(currentFile !== null && {
          toExecutable: currentFile.executable,
        }),
      },
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
    hasher.update(files.get(rel)!.content);
    hasher.update("\0");
  }
  return hasher.digest("hex").slice(0, 12);
}

export interface UnifiedDiffOptions {
  fromExecutable?: boolean;
  toExecutable?: boolean;
}

/**
 * Git treats a file as binary when a NUL appears in its first 8000 bytes, which
 * also catches UTF-16 text that can survive a fatal UTF-8 decode.
 */
function decodeDiffText(content: Buffer): string | null {
  if (content.subarray(0, 8000).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/**
 * The isolated git profile passes `--text`, disabling git's binary check, so
 * binary sides are caught here; equal binary bytes still go to git for
 * mode-only diffs.
 */
export async function unifiedDiffBytes(
  fromLabel: string,
  toLabel: string,
  fromBytes: Buffer | null,
  toBytes: Buffer | null,
  options: UnifiedDiffOptions = {},
): Promise<string> {
  const fromText = fromBytes === null ? null : decodeDiffText(fromBytes);
  const toText = toBytes === null ? null : decodeDiffText(toBytes);
  const binary =
    (fromBytes !== null && fromText === null) ||
    (toBytes !== null && toText === null);
  if (!binary) {
    return await unifiedDiff(fromLabel, toLabel, fromText, toText, options);
  }
  if (fromBytes !== null && toBytes !== null && fromBytes.equals(toBytes)) {
    return await unifiedDiff(fromLabel, toLabel, "", "", options);
  }
  return `--- ${fromLabel}\n+++ ${toLabel}\nBinary files differ\n`;
}

/**
 * `null` (absent) differs from empty: diffing `/dev/null` against an empty file
 * reports `new file mode`, while two empty files report nothing.
 */
export async function unifiedDiff(
  fromLabel: string,
  toLabel: string,
  fromText: string | null,
  toText: string | null,
  options: UnifiedDiffOptions = {},
): Promise<string> {
  const fromExecutable = options.fromExecutable === true;
  const toExecutable = options.toExecutable === true;
  if (fromText === toText && fromExecutable === toExecutable) return "";

  const dir = await mkdtemp(join(tmpdir(), "capshelf-diff-"));
  const currentPath = fromText === null ? DEV_NULL : join(dir, "current");
  const expectedPath = toText === null ? DEV_NULL : join(dir, "locked");
  try {
    if (fromText !== null) {
      await writeFile(currentPath, fromText);
      if (fromExecutable) await chmod(currentPath, 0o755);
    }
    if (toText !== null) {
      await writeFile(expectedPath, toText);
      if (toExecutable) await chmod(expectedPath, 0o755);
    }
    // The isolated-diff profile sets neutral line-ending and attribute config,
    // so a user setting such as `core.autocrlf=input` cannot hide a
    // CRLF-versus-LF difference.
    const result = await isolatedNoIndexDiff(dir, currentPath, expectedPath);
    if (result.exitCode === 0) return "";
    if (result.exitCode !== 1) {
      throw new Error(result.stderr || "git diff failed");
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
  let labelled = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) continue;
    if (line.startsWith("index ")) continue;
    if (line === `--- ${currentPath}` || line.startsWith(`--- a/`)) {
      out.push(`--- ${fromLabel}`);
      labelled = true;
    } else if (line === `+++ ${expectedPath}` || line.startsWith(`+++ b/`)) {
      out.push(`+++ ${toLabel}`);
    } else {
      out.push(line);
    }
  }
  // A mode-only change has no `---`/`+++` pair, so add one to name the file.
  if (!labelled && out.some((line) => line.trim().length > 0)) {
    out.unshift(`--- ${fromLabel}`, `+++ ${toLabel}`);
  }
  return out.join("\n");
}
