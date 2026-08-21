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
  itemRepoRelPath,
} from "./master";
import type { CopyDirectoryItemKind, ItemKind } from "./master";
import type { ItemSource } from "./installed";
import { installedPath } from "./installed";
import { findSystemItem } from "./bundled";
import {
  assertRegularBlobEntries,
  catFileBlobs,
  isolatedNoIndexDiff,
  sourceRead,
  sourceReadText,
  literalPathspec,
  lsTreeEntriesAtCommit,
  lsTreeEntriesForPathspecs,
  showAtCommit,
} from "./git";
import { hasIgnoredDotSegment } from "./dotfiles";
import { missingSourceCommitMessage } from "./upstream-check";
import { gitignoreVisibleFiles } from "./gitignore";
import {
  allCanonicalFragmentRelPaths,
  isFragmentKind,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
} from "./fragments";
import { subagentSourcesAtCommit } from "./subagents";
import { lstatOrNull } from "./fs-utils";
import { currentSourceCommit } from "./pin";

type LocalDiffState =
  | "drifted_local"
  | "drifted_and_update"
  | "missing_installed"
  | "missing_output"
  | "drifted_and_upstream_dirty"
  | "output_drift"
  | "source_dirty"
  | "source_dirty_and_output_drift"
  | "missing_source_commit";

interface DiffableStatusRow {
  scope?: "project" | "local";
  source: ItemSource;
  kind: ItemKind;
  name: string;
  state: string;
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
}

interface CopyDirectoryFilesOptions {
  project: string;
  dataRepo: string | null;
  manifest: Manifest;
  source: ItemSource;
  kind: CopyDirectoryItemKind;
  name: string;
  sourceCommit?: string;
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

/** The path git prints, and accepts, for a side that does not exist. */
const DEV_NULL = "/dev/null";

export function shouldShowLocalDiff(state: string): state is LocalDiffState {
  return (
    state === "drifted_local" ||
    state === "drifted_and_update" ||
    state === "missing_installed" ||
    state === "missing_output" ||
    state === "drifted_and_upstream_dirty" ||
    state === "output_drift" ||
    state === "source_dirty" ||
    state === "source_dirty_and_output_drift" ||
    state === "missing_source_commit"
  );
}

export async function buildStatusDiff(
  opts: StatusDiffOptions,
): Promise<StatusDiff | null> {
  const { row } = opts;
  const view: "installed" | "upstream" =
    opts.view === "upstream" ? "upstream" : "installed";
  if (view === "installed" && !shouldShowLocalDiff(row.state)) return null;
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
  const lockedSha = entry
    ? (("sourcePinDigest" in entry ? entry.sourcePinDigest : entry.sha) ?? null)
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
          dataRepo: opts.dataRepo,
          manifest: opts.manifest,
          source: row.source,
          kind: row.kind,
          name: row.name,
          sourceCommit: upstreamCommit,
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
      const plan = await planFragmentOutput({
        project: opts.project,
        dataRepo: opts.dataRepo,
        manifest: opts.manifest,
        oldLock: opts.lock,
        nextLock: opts.lock,
        target,
      });
      firstPath ||= plan.path;
      // locked is the baseline (---), current is the new side (+++), so a local
      // edit reads as an addition, matching `git diff` convention.
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
    );
    const parts: string[] = [];
    for (const source of sources) {
      const expected = await showAtCommit(
        opts.dataRepo,
        row.sourceCommit,
        source.relPath,
      );
      const currentStat = lstatOrNull(source.outputPath);
      const current =
        currentStat?.isFile() && !currentStat.isSymbolicLink()
          ? await readFile(source.outputPath)
          : Buffer.alloc(0);
      const text = await unifiedDiff(
        `${source.outputPath} (locked)`,
        `${source.outputPath} (current)`,
        expected.toString("utf-8"),
        current.toString("utf-8"),
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

  // Ordinary status only needs the locked path set so ignored-but-managed
  // files still participate in the current hash. Loading every locked blob
  // here used to run one `git show` subprocess per file even though none of
  // those bytes were used; reserve that work for `status --diff`.
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!info.isFile()) return true;
    if (((info.mode & 0o111) !== 0) !== executable) return true;
  }
  return false;
}

/**
 * The dirty canonical sources of a fragment item, as text.
 *
 * `status` is read-only, so it runs no program the data repo names (GIT-11).
 * That rules out asking Git for the diff: `git diff HEAD` converts the
 * working-tree file with `convert_to_git` before comparing it, so a
 * `filter=<driver>` attribute starts `filter.<driver>.clean`, and no
 * per-invocation flag disables a driver whose name is unknown. Reproduced —
 * with a rewriting clean filter the diff reported `{"v":REDACTED}` for a file
 * holding `{"v":2}`, which is the exact failure this design exists to close:
 * the one command a user runs to investigate disagreeing with the bytes.
 *
 * So both sides are read as bytes — the commit from the object database, which
 * applies no smudge filter, and the working tree from the filesystem — and
 * compared in the disposable, attribute-free directory `unifiedDiff` owns.
 */
async function dataRepoDiff(
  dataRepo: string,
  relPaths: string[],
): Promise<string> {
  const committed = await committedSources(dataRepo, relPaths);
  const staged = await stagedSourcePaths(dataRepo, relPaths);
  const untracked = await untrackedDataRepoFiles(dataRepo, relPaths);
  // A file you staged but did not commit is in none of git's other answers:
  // `HEAD` does not hold it, and `ls-files --others` skips it because git
  // tracks it now. Without the index the path is compared by nothing.
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
    // `git rm --cached` leaves the file on disk, so neither side of the
    // comparison above moves and the staged removal renders as nothing.
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
 * The canonical sources as `HEAD` holds them, read through `cat-file`, which
 * runs no smudge filter and consults no working tree.
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
 * The canonical paths the index holds. `ls-files --stage` reads the index
 * alone: it opens no working-tree file, so no clean filter runs. Only the
 * path set is used, which is why unmerged stages need no policy here.
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
    // "<mode> <object> <stage>\t<path>", verbatim under -z.
    const match = /^\d{6} [0-9a-f]+ \d\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`unexpected git ls-files output: ${record}`);
    paths.add(match[1]!);
  }
  return paths;
}

/** The working-tree side, read from the filesystem rather than through git. */
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
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    source: opts.row.source,
    kind: opts.row.kind,
    name: opts.row.name,
    sourceCommit: opts.row.sourceCommit,
  });
}

async function expectedFilesForCopyItem(
  opts: CopyDirectoryFilesOptions,
): Promise<FileMap | null> {
  if (opts.source === "system") {
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

  if (!opts.dataRepo) return null;
  if (!opts.sourceCommit) return null;

  const files = await expectedFileEntriesForCopyItem(opts);
  if (!files) return null;
  const repoRelPath = itemRepoRelPath(opts.kind, opts.name);
  const out: FileMap = new Map();
  for (const expected of files) {
    out.set(expected.rel, {
      content: await showExpectedFile(
        opts,
        opts.sourceCommit,
        posix.join(repoRelPath, expected.rel),
      ),
      executable: expected.executable,
    });
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
): Promise<Array<{ rel: string; executable: boolean }> | null> {
  if (opts.source === "system") {
    const item = findSystemItem(opts.name);
    if (!item || item.kind !== opts.kind) return null;
    return item.files.map((file) => ({
      rel: file.relPath,
      executable: false,
    }));
  }

  if (!opts.dataRepo) return null;
  if (!opts.sourceCommit) return null;

  const repoRelPath = itemRepoRelPath(opts.kind, opts.name);
  let entries: Awaited<ReturnType<typeof lsTreeEntriesAtCommit>>;
  try {
    entries = await lsTreeEntriesAtCommit(
      opts.dataRepo,
      opts.sourceCommit,
      repoRelPath,
    );
  } catch {
    throw new Error(
      missingSourceCommitMessage(
        opts.dataRepo,
        opts.sourceCommit,
        opts.manifest,
      ),
    );
  }
  assertRegularBlobEntries(entries, repoRelPath);
  return entries
    .map((entry) => ({
      rel: posix.relative(repoRelPath, entry.path),
      executable: entry.mode === "100755",
    }))
    .filter(
      ({ rel }) =>
        rel.length > 0 &&
        !rel.startsWith("..") &&
        !hasIgnoredDotSegment(rel) &&
        // A committed metadata sidecar is catalog data, not locked content;
        // it must not participate in status hashes or diffs.
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
  expectedPaths: Iterable<string>,
): Promise<FileMap> {
  const out: FileMap = new Map();
  if (!existsSync(root)) return out;

  // A project-side root .capshelf.yml is never managed content: keep it out
  // of the file-map hash (currentCopyDirectoryItemSha) and status --diff.
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
    // locked is the baseline (---), current the new side (+++) — see above.
    const text = await unifiedDiff(
      `${file} (locked${lockedCommit ? ` ${lockedCommit.slice(0, 7)}` : ` ${item}`})`,
      `${file} (${view}${targetCommit ? ` ${targetCommit.slice(0, 7)}` : ""})`,
      expectedFile?.content.toString("utf-8") ?? null,
      currentFile?.content.toString("utf-8") ?? null,
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
 * A side is `null` when the file does not exist on that side. That is not the
 * same as an empty file, and collapsing the two hides a real change: comparing
 * two empty files reports nothing, while comparing `/dev/null` with an empty
 * file reports `new file mode 100644`. Git renders existence and mode itself
 * once it is given them, so neither is reconstructed here.
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
    // The `isolated-diff` profile owns every flag and environment decision
    // here (`src/git.ts`). This used to run under `repo === null`, which meant
    // "in the user's own directory, under their global config" — so on the
    // machine that produced the original bug report `--diff` printed nothing
    // for a CRLF-versus-LF difference, because `core.autocrlf=input`
    // normalized it away before the comparison.
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
  // A mode-only change carries no `---`/`+++` pair, so without this the output
  // would be two mode lines with nothing naming the file they describe.
  if (!labelled && out.some((line) => line.trim().length > 0)) {
    out.unshift(`--- ${fromLabel}`, `+++ ${toLabel}`);
  }
  return out.join("\n");
}
