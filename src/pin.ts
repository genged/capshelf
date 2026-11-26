import { gitObjectReadKey, type GitReadMemo } from "./git-read-memo";
import { constants } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { PreconditionError } from "./errors";
import { isErrno } from "./fs-utils";
import {
  assertRegularBlobEntries,
  literalPathspec,
  lsTreeEntriesForPathspecs,
  catFileBlobs,
  catFileSizes,
  MEMO_BLOB_LIMIT,
  checkAttrAtCommit,
  contentCommitPathspecs,
  lastTouchingCommitForPaths,
  lastTouchingContentCommit,
  prefetchLastTouchingCommits,
  registerBatchReads,
  resolveCommit,
} from "./git";
import type { GitTreeEntry, LastTouchingOptions, IgnoreRule } from "./git";
import { PRODUCT_NAME } from "./identity";
import { ignoreRuleLine } from "./publication-ignore";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
  itemRelPathsWithinRoot,
  itemRepoRelPath,
} from "./master";
import type { ItemKind } from "./master";
import { gitTreeSource } from "./item-source";
import type { GitTreeSource } from "./item-source";
import type { GitFileMode } from "./merge-tree";

/**
 * Identity comes from committed names, modes, and blob ids, so working-tree
 * state and checkout filters cannot change the pinned identity.
 */

const PIN: unique symbol = Symbol("capshelf.pin");

export interface PinTreeEntry {
  readonly path: string;
  readonly mode: GitFileMode;
  readonly blobId: string;
  readonly repoRelPath: string;
}

/**
 * The brand is compile-time pressure, not enforcement: a type assertion, a
 * deserializer, or a second lock serializer can bypass it. It holds because
 * construction is module-private, the digest is computed inside this module,
 * the entries and the pin are frozen, and lock mutation lives in one place. The
 * brand key is a module-private symbol that `JSON.stringify` never writes.
 */
export interface PinnedSource {
  readonly [PIN]: true;
  readonly sourcePinDigest: string;
  readonly sourceCommit: string;
  readonly entries: readonly PinTreeEntry[];
}

export const PIN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Display only; the lock always carries the full digest. */
export function abbreviatePin(digest: string): string {
  return digest.slice(0, 12);
}

/**
 * Version-3 `sha` values are already 12 characters, so only a 64-character
 * digest is abbreviated.
 */
export function shortIdentity(value: string | null | undefined): string {
  if (!value) return "(missing)";
  return value.length === 64 ? abbreviatePin(value) : value;
}

/**
 * Sort by UTF-16 code units, matching `hashNamedContents`, so `localeCompare`
 * can't make implementations disagree.
 */
export function sourcePinDigest(entries: readonly PinTreeEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  for (const entry of sorted) {
    hasher.update(entry.path);
    hasher.update("\0");
    hasher.update(entry.mode);
    hasher.update("\0");
    hasher.update(entry.blobId);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

export type GitHashWidth = 40 | 64;

/**
 * Infer width from `ls-tree` ids: SHA-256 repos use 64-hex object names, and
 * assuming SHA-1 would mark every file modified.
 */
export function hashWidthOf(entries: readonly PinTreeEntry[]): GitHashWidth {
  for (const entry of entries) {
    if (entry.blobId.length === 64) return 64;
    if (entry.blobId.length === 40) return 40;
    throw new Error(`unexpected git object name width: ${entry.blobId}`);
  }
  return 40;
}

export function blobIdOf(bytes: Uint8Array, width: GitHashWidth): string {
  const hasher = new Bun.CryptoHasher(width === 64 ? "sha256" : "sha1");
  hasher.update(`blob ${bytes.length}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
}

/**
 * The source names repo, commit and root while the kind names the paths inside
 * it, so a non-canonical root needs no second path rule.
 */
export async function itemTreeEntriesAtCommit(
  source: GitTreeSource,
  kind: ItemKind,
  memo?: GitReadMemo,
): Promise<PinTreeEntry[]> {
  const itemRoot = source.itemRoot;
  const raw = await lsTreeEntriesForPathspecs(
    source.repo,
    source.commit,
    itemTreePathspecs(source, kind),
    { memo },
  );
  // Refuse gitlinks and symlinks up front so a pin never names something
  // materialization can't write.
  assertRegularBlobEntries(raw, itemRoot);
  const entries: PinTreeEntry[] = [];
  for (const entry of raw) {
    const rel = itemRelativePath(itemRoot, entry);
    if (rel === null) continue;
    if (isMetadataSidecarPath(rel)) continue;
    entries.push({
      path: rel,
      mode: entry.mode === "100755" ? "100755" : "100644",
      blobId: entry.object,
      repoRelPath: entry.path,
    });
  }
  return entries.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

function itemTreePathspecs(source: GitTreeSource, kind: ItemKind): string[] {
  return isCopyDirectoryItemKind(kind)
    ? [literalPathspec(source.itemRoot)]
    : itemRelPathsWithinRoot(kind).map((rel) =>
        literalPathspec(`${source.itemRoot}/${rel}`),
      );
}

function itemRelativePath(
  itemRoot: string,
  entry: GitTreeEntry,
): string | null {
  const rel = posix.relative(itemRoot, entry.path);
  if (!rel || rel.startsWith("..")) return null;
  // Git paths are bytes, not necessarily UTF-8; refuse non-round-tripping paths
  // rather than alias them via replacement characters into machine-dependent
  // digests.
  if (rel.includes("�")) {
    throw new PreconditionError(
      `${entry.path} does not round-trip through UTF-8; capshelf cannot pin it`,
    );
  }
  return rel;
}

function brandPin(sourceCommit: string, entries: PinTreeEntry[]): PinnedSource {
  const frozen = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  const pin: PinnedSource = {
    [PIN]: true,
    sourcePinDigest: sourcePinDigest(frozen),
    sourceCommit,
    entries: frozen,
  };
  return Object.freeze(pin);
}

export interface PinOptions {
  /**
   * Skips the filter check; only the one-time `lock migrate` audit sets this.
   */
  skipFilterCheck?: boolean;
  memo?: GitReadMemo;
  head?: string;
}

export async function pinItemAtCommit(
  source: GitTreeSource,
  kind: ItemKind,
  name: string,
  options: PinOptions = {},
): Promise<PinnedSource> {
  const resolved = await resolveCommit(source.repo, source.commit);
  if (resolved === null) {
    throw new PreconditionError(
      `data repo at ${source.repo} does not contain commit ${source.commit}`,
    );
  }
  return await pinResolvedCommit(source, resolved, kind, name, options);
}

async function pinResolvedCommit(
  source: GitTreeSource,
  resolved: string,
  kind: ItemKind,
  name: string,
  options: PinOptions,
): Promise<PinnedSource> {
  const entries = await itemTreeEntriesAtCommit(
    { ...source, commit: resolved },
    kind,
    options.memo,
  );
  if (entries.length === 0) {
    throw new Error(
      `${source.itemRoot} has no materializable files at ${source.commit}`,
    );
  }
  if (options.skipFilterCheck !== true) {
    await assertNoExternalFilterDrivers(
      source.repo,
      resolved,
      [{ kind, name, entries }],
      options.memo,
    );
  }
  return brandPin(resolved, entries);
}

/**
 * For a copy-directory item the metadata sidecar is excluded, so a sidecar-only
 * commit never moves the pin.
 */
export async function currentSourceCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  options: LastTouchingOptions = {},
): Promise<string> {
  if (isCopyDirectoryItemKind(kind)) {
    return await lastTouchingContentCommit(
      dataRepo,
      itemRepoRelPath(kind, name),
      options,
    );
  }
  if (isCopyTargetFileItemKind(kind) || isFragmentItemKind(kind)) {
    return await lastTouchingCommitForPaths(
      dataRepo,
      allCanonicalItemRelPaths(kind, name),
      options,
    );
  }
  throw new Error(`no pin strategy for ${kind}/${name}`);
}

/**
 * One history walk fills `memo` so later `currentSourceCommit` calls with the
 * same `head` spawn no Git process.
 */
export async function prefetchSourceCommits(
  dataRepo: string,
  head: string,
  items: ReadonlyArray<{ kind: ItemKind; name: string }>,
  memo: GitReadMemo,
): Promise<void> {
  const lists = items.flatMap(({ kind, name }) =>
    isCopyDirectoryItemKind(kind)
      ? [contentCommitPathspecs(itemRepoRelPath(kind, name))]
      : isCopyTargetFileItemKind(kind) || isFragmentItemKind(kind)
        ? [allCanonicalItemRelPaths(kind, name).map(literalPathspec)]
        : [],
  );
  await prefetchLastTouchingCommits(dataRepo, head, lists, memo).catch(
    () => undefined,
  );
}

/**
 * `git log --format=%H` prints the full id of a walked commit, so no second
 * `rev-parse --verify` is needed.
 */
export async function pinCurrentSource(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  options: PinOptions = {},
): Promise<PinnedSource> {
  const commit = await currentSourceCommit(dataRepo, kind, name, {
    head: options.head,
    memo: options.memo,
  });
  return await pinResolvedCommit(
    gitTreeSource({ repo: dataRepo, kind, name, commit }),
    commit,
    kind,
    name,
    options,
  );
}

export interface FilteredPath {
  ref: string;
  path: string;
  driver: string;
}

export interface FilterCheckSubject {
  kind: ItemKind;
  name: string;
  entries: readonly PinTreeEntry[];
}

/**
 * Refuse external filter drivers: Git stores a pointer or ciphertext, which
 * tree identity would deliver faithfully and wrongly to every consumer. Git's
 * built-in transforms (text, eol, ident, working-tree-encoding) apply in every
 * clone and are allowed.
 */
export async function filteredPathsAtCommit(
  dataRepo: string,
  commit: string,
  subjects: readonly FilterCheckSubject[],
  observeObjectsDir?: () => Promise<string>,
  memo?: GitReadMemo,
): Promise<FilteredPath[]> {
  const paths: string[] = [];
  const owner = new Map<string, string>();
  for (const subject of subjects) {
    for (const entry of subject.entries) {
      paths.push(entry.repoRelPath);
      owner.set(entry.repoRelPath, `${subject.kind}/${subject.name}`);
    }
  }
  if (paths.length === 0) return [];
  const results = await checkAttrAtCommit(
    dataRepo,
    commit,
    paths,
    ["filter"],
    observeObjectsDir,
    memo,
  );
  const filtered: FilteredPath[] = [];
  for (const result of results) {
    if (result.attribute !== "filter") continue;
    if (
      result.value === "unspecified" ||
      result.value === "unset" ||
      result.value === "set"
    ) {
      continue;
    }
    filtered.push({
      ref: owner.get(result.path) ?? result.path,
      path: result.path,
      driver: result.value,
    });
  }
  return filtered;
}

export async function assertNoExternalFilterDrivers(
  dataRepo: string,
  commit: string,
  subjects: readonly FilterCheckSubject[],
  memo?: GitReadMemo,
): Promise<void> {
  const filtered = await filteredPathsAtCommit(
    dataRepo,
    commit,
    subjects,
    undefined,
    memo,
  );
  if (filtered.length === 0) return;
  throw new PreconditionError(filterRefusalMessage(filtered));
}

export function filterRefusalMessage(
  filtered: readonly FilteredPath[],
): string {
  const refs = [...new Set(filtered.map((entry) => entry.ref))];
  const width = Math.max(...filtered.map((entry) => entry.path.length));
  return [
    `${refs.join(", ")} declares a git content filter, so its content is not portable`,
    "",
    ...filtered.map(
      (entry) => `    ${entry.path.padEnd(width)}    filter=${entry.driver}`,
    ),
    "",
    "  git stores a placeholder for this file, not the file. Every project would",
    "  receive the placeholder.",
    "",
    "  fix by one of:",
    "    move the path out of the item",
    "    commit the file already encrypted, with no filter attribute (sops, age)",
  ].join("\n");
}

/**
 * Group by source commit: one attribute query per distinct commit, because a
 * single query cannot mix attribute sources.
 */
export async function filteredPathsForPins(
  dataRepo: string,
  pins: ReadonlyArray<{ kind: ItemKind; name: string; pin: PinnedSource }>,
): Promise<FilteredPath[]> {
  const byCommit = new Map<string, FilterCheckSubject[]>();
  for (const { kind, name, pin } of pins) {
    const group = byCommit.get(pin.sourceCommit) ?? [];
    group.push({ kind, name, entries: pin.entries });
    byCommit.set(pin.sourceCommit, group);
  }
  const filtered: FilteredPath[] = [];
  for (const [commit, subjects] of byCommit) {
    filtered.push(...(await filteredPathsAtCommit(dataRepo, commit, subjects)));
  }
  return filtered;
}

export interface InstalledEntryObservation {
  path: string;
  missing?: true;
  unusable?: "unsupported-type" | "unreadable";
  mode?: GitFileMode;
  blobId?: string;
  bytes?: Buffer;
}

/**
 * O_NOFOLLOW prevents leaf symlink substitution. Check that the opened
 * descriptor is a regular file before reading from that same descriptor.
 * Concurrent replacement of an ancestor directory is outside the threat model.
 */
export interface InstalledTarget {
  path: string;
  absolutePath: string;
}

export function targetsUnderRoot(
  root: string,
  entries: readonly PinTreeEntry[],
): InstalledTarget[] {
  return entries.map((entry) => ({
    path: entry.path,
    absolutePath: join(root, ...entry.path.split("/")),
  }));
}

export async function observeInstalledEntries(
  targets: readonly InstalledTarget[],
  width: GitHashWidth,
  options: { keepBytes?: boolean } = {},
): Promise<InstalledEntryObservation[]> {
  const out: InstalledEntryObservation[] = [];
  for (const entry of targets) {
    const fullPath = entry.absolutePath;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = isErrno(error) ? error.code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        out.push({ path: entry.path, missing: true });
        continue;
      }
      // ELOOP is the O_NOFOLLOW refusal and EISDIR means a directory sits where
      // a file is pinned; both must not be overwritten.
      out.push({
        path: entry.path,
        unusable:
          code === "ELOOP" || code === "EISDIR"
            ? "unsupported-type"
            : "unreadable",
      });
      continue;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        out.push({ path: entry.path, unusable: "unsupported-type" });
        continue;
      }
      const bytes = await handle.readFile();
      out.push({
        path: entry.path,
        mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
        blobId: blobIdOf(bytes, width),
        ...(options.keepBytes === true && { bytes }),
      });
    } catch {
      out.push({ path: entry.path, unusable: "unreadable" });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return out;
}

/**
 * Absent or unusable paths get a sentinel no real entry can produce, so the
 * comparison stays total instead of silently narrowing the hashed set.
 */
export async function installedPinDigest(
  targets: readonly InstalledTarget[],
  width: GitHashWidth,
): Promise<string> {
  const observed = await observeInstalledEntries(targets, width);
  return sourcePinDigest(
    observed.map((observation) => ({
      path: observation.path,
      mode: observation.mode ?? "100644",
      blobId:
        observation.blobId ??
        (observation.missing === true ? "(missing)" : "(unreadable)"),
      repoRelPath: observation.path,
    })),
  );
}

export interface PinnedBytes {
  path: string;
  mode: GitFileMode;
  content: Buffer;
}

/**
 * Every command that writes managed files reads bytes the same way: the pin's
 * blob ids through one `cat-file --batch`, never the data repo working tree.
 */
export async function readPinnedBytes(
  dataRepo: string,
  pin: PinnedSource,
): Promise<PinnedBytes[]> {
  return await readEntryBytes(dataRepo, pin.entries);
}

export async function readEntryBytes(
  dataRepo: string,
  entries: readonly PinTreeEntry[],
  memo?: GitReadMemo,
): Promise<PinnedBytes[]> {
  const blobs = await catFileBlobs(
    dataRepo,
    entries.map((entry) => entry.blobId),
    memo,
  );
  return entries.map((entry) => {
    const content = blobs.get(entry.blobId);
    if (content === undefined) {
      throw new Error(
        `data repo at ${dataRepo} could not supply blob ${entry.blobId} for ${entry.path}`,
      );
    }
    return { path: entry.path, mode: entry.mode, content };
  });
}

export interface ItemAtCommit {
  kind: ItemKind;
  name: string;
  commit: string;
}

/**
 * Only commits shared by two or more items are batched, since a batch for a
 * lone item would only read more; only item paths are read so cost doesn't
 * scale with repo size.
 */
export function batchItemReads(
  dataRepo: string,
  items: ReadonlyArray<ItemAtCommit>,
  memo: GitReadMemo,
): void {
  const byCommit = new Map<string, ItemAtCommit[]>();
  for (const item of items) {
    const group = byCommit.get(item.commit) ?? [];
    if (
      !group.some(
        (other) => other.kind === item.kind && other.name === item.name,
      )
    ) {
      group.push(item);
    }
    byCommit.set(item.commit, group);
  }
  for (const [commit, group] of byCommit) {
    if (group.length < 2) continue;
    registerBatchReads(
      memo,
      dataRepo,
      commit,
      group.flatMap(({ kind, name }) =>
        itemTreePathspecs(
          gitTreeSource({ repo: dataRepo, kind, name, commit }),
          kind,
        ),
      ),
    );
  }
}

/**
 * Caps the single prefetch buffer, since the memo retains a copy of each small
 * blob until the command ends; above it, items read their own bytes.
 */
export const PREFETCH_BYTE_BUDGET = 32 * 1024 * 1024;

/**
 * A blob id names its bytes, so memoized reads cannot go stale; unreadable
 * items are skipped so their own read reports the error.
 */
export async function prefetchItemBlobs(
  dataRepo: string,
  items: ReadonlyArray<ItemAtCommit>,
  memo: GitReadMemo,
  budget = PREFETCH_BYTE_BUDGET,
): Promise<void> {
  batchItemReads(dataRepo, items, memo);
  const ids = new Set<string>();
  for (const { kind, name, commit } of items) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) continue;
    const source = gitTreeSource({ repo: dataRepo, kind, name, commit });
    const entries = await itemTreeEntriesAtCommit(source, kind, memo).catch(
      () => [],
    );
    for (const entry of entries) ids.add(entry.blobId);
  }
  for (const id of ids) {
    const key = gitObjectReadKey(dataRepo, id);
    if (key !== undefined && memo.blobs.has(key)) ids.delete(id);
  }
  const distinct = new Set(items.map((item) => `${item.kind}/${item.name}`));
  if (ids.size === 0 || distinct.size < 2) return;
  const sizes = await catFileSizes(dataRepo, ids).catch(() => undefined);
  if (sizes === undefined) return;
  const small = [...sizes].filter(([, size]) => size <= MEMO_BLOB_LIMIT);
  const total = small.reduce((sum, [, size]) => sum + size, 0);
  if (small.length === 0 || total > budget) return;
  await catFileBlobs(
    dataRepo,
    small.map(([id]) => id),
    memo,
  ).catch(() => undefined);
}

export interface CommitProofMismatch {
  path: string;
  candidate: string | null;
  committed: string | null;
}

/**
 * Compute candidate ids from the selected bytes because Git or repository
 * policy can change them before commit. A comparison of destination bytes alone
 * cannot prove that the selected candidate was committed.
 */
export function namedFilesTreeEntries(
  files: ReadonlyArray<{ path: string; mode: GitFileMode; content: Buffer }>,
  width: GitHashWidth,
): PinTreeEntry[] {
  return files.map((file) => ({
    path: file.path,
    mode: file.mode,
    blobId: blobIdOf(file.content, width),
    repoRelPath: file.path,
  }));
}

export function compareCandidateToCommit(
  candidateFiles: ReadonlyArray<{
    path: string;
    mode: GitFileMode;
    content: Buffer;
  }>,
  committed: readonly PinTreeEntry[],
): CommitProofMismatch[] {
  const width = hashWidthOf(committed);
  const candidateIds = new Map(
    candidateFiles.map((file) => [
      file.path,
      `${file.mode}:${blobIdOf(file.content, width)}`,
    ]),
  );
  const committedIds = new Map(
    committed.map((entry) => [entry.path, `${entry.mode}:${entry.blobId}`]),
  );
  const mismatches: CommitProofMismatch[] = [];
  for (const path of new Set([
    ...candidateIds.keys(),
    ...committedIds.keys(),
  ])) {
    const left = candidateIds.get(path) ?? null;
    const right = committedIds.get(path) ?? null;
    if (left === right) continue;
    mismatches.push({
      path,
      candidate: left?.split(":")[1] ?? null,
      committed: right?.split(":")[1] ?? null,
    });
  }
  return mismatches.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function commitProofRefusalMessage(
  ref: string,
  mismatches: readonly CommitProofMismatch[],
  ruleFor: (path: string) => IgnoreRule | undefined = () => undefined,
): string {
  const width = Math.max(...mismatches.map((entry) => entry.path.length));
  const rows: string[] = [];
  for (const entry of mismatches) {
    rows.push(
      `    ${entry.path.padEnd(width)}    selected ${abbreviatePin(entry.candidate ?? "(absent)")}   committed ${abbreviatePin(entry.committed ?? "(absent)")}`,
    );
    const rule = entry.committed === null ? ruleFor(entry.path) : undefined;
    if (rule) rows.push(ignoreRuleLine(rule));
  }
  return [
    `not publishing ${ref}`,
    "  the committed content is not the selected publication content",
    "",
    ...rows,
    "",
    "  possible causes in the data repo: an ignore rule, a pre-commit hook,",
    "  a clean filter, or a .gitattributes rule",
    "  the data repo was rolled back; nothing was published",
  ].join("\n");
}

export interface NameCollision {
  key: string;
  paths: string[];
}

/**
 * The tree is case-sensitive and byte-addressed but APFS/NTFS can collapse
 * paths differing in case or Unicode normalization; folding is probed rather
 * than assumed because lowercase+NFC guesses are wrong in both directions.
 */
export function findNameCollisions(
  paths: readonly string[],
  folding: { caseFolding: boolean; normalizationFolding: boolean },
): NameCollision[] {
  const byKey = new Map<string, string[]>();
  for (const path of paths) {
    const key = destinationKey(path, folding);
    byKey.set(key, [...(byKey.get(key) ?? []), path]);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, paths: [...group].sort() }));
}

export function destinationKey(
  path: string,
  folding: { caseFolding: boolean; normalizationFolding: boolean },
): string {
  let key = path;
  if (folding.normalizationFolding) key = key.normalize("NFC");
  if (folding.caseFolding) key = key.toLowerCase();
  return key;
}

export function couldFold(paths: readonly string[]): boolean {
  const all = { caseFolding: true, normalizationFolding: true };
  return findNameCollisions(paths, all).length > 0;
}

export interface DestinationFolding {
  caseFolding: boolean;
  normalizationFolding: boolean;
}

const NO_FOLDING: DestinationFolding = {
  caseFolding: false,
  normalizationFolding: false,
};

/**
 * Folding is observed, not assumed: lowercase+NFC over-folds on case-sensitive
 * volumes and under-folds on filesystems with their own equivalence rules.
 */
export async function probeDestinationFolding(
  destination: string,
): Promise<DestinationFolding> {
  const parent = await nearestExistingAncestor(destination);
  if (parent === null) return NO_FOLDING;
  let workspace: string;
  try {
    workspace = await mkdtemp(join(parent, ".capshelf-name-probe-"));
  } catch {
    return NO_FOLDING;
  }
  try {
    // "Ä" is both case-bearing and decomposable, so one probe answers both
    // questions.
    const probe = "Ä-Probe";
    await writeFile(join(workspace, probe), "");
    return {
      caseFolding: await resolvesToProbe(workspace, probe.toLowerCase()),
      normalizationFolding: await resolvesToProbe(
        workspace,
        probe.normalize("NFD"),
      ),
    };
  } catch {
    return NO_FOLDING;
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

async function resolvesToProbe(
  workspace: string,
  candidate: string,
): Promise<boolean> {
  try {
    await stat(join(workspace, candidate));
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingAncestor(path: string): Promise<string | null> {
  let current = dirname(path);
  for (;;) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      // Keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function assertNoDestinationCollisions(
  ref: string,
  destination: string,
  paths: readonly string[],
): Promise<void> {
  if (!couldFold(paths)) return;
  const folding = await probeDestinationFolding(destination);
  const collisions = findNameCollisions(paths, folding);
  if (collisions.length === 0) return;
  throw new PreconditionError(
    collisionRefusalMessage(ref, destination, collisions),
  );
}

export function collisionRefusalMessage(
  ref: string,
  destination: string,
  collisions: readonly NameCollision[],
): string {
  return [
    `${ref} has pinned paths that collide on ${destination}`,
    ...collisions.flatMap((collision) => [
      `    ${collision.paths.join("  and  ")}`,
    ]),
    "  the destination filesystem folds these names onto one file, so the install",
    "  would hold one file where the source tree holds two",
    `  fix it in the data repo, then re-run: ${PRODUCT_NAME} update ${ref}`,
  ].join("\n");
}
