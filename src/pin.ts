import { constants } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { PreconditionError } from "./errors";
import {
  assertRegularBlobEntries,
  literalPathspec,
  lsTreeEntriesForPathspecs,
  catFileBlobs,
  checkAttrAtCommit,
  lastTouchingCommitForPaths,
  lastTouchingContentCommit,
  resolveCommit,
} from "./git";
import type { GitTreeEntry } from "./git";
import { PRODUCT_NAME } from "./identity";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
  itemRepoRelPath,
} from "./master";
import type { ItemKind } from "./master";
import type { GitFileMode } from "./merge-tree";

/*
 * PIN-1: IDENTITY IS THE GIT TREE
 *
 * A data lock entry records a content identity and a source commit. Every
 * consumer depends on one claim:
 *
 *     identity(content at entry.sourceCommit) == entry identity
 *
 * Before lock version 4 capshelf never verified that claim where entries were
 * written. It took identity from the data repo *working tree* and the commit
 * from `git log -1`, and treated a clean `git status` as proof the two agreed.
 * Git's cleanliness is not byte equality, so a clean filter, an index bit, or a
 * sparse checkout produced a lock that no later command could apply, reported
 * as `up-to-date` forever.
 *
 * Here identity *is* the tree:
 *
 *     sourcePinDigest = sha256 over sorted (name, mode, blobId) from one ls-tree
 *
 * There is nothing left to prove, because there is no second input set to
 * disagree with the first. Computing it reads no file content — not one byte —
 * so working-tree state, Git configuration, checkout filters, ignore rules, and
 * the filesystem cannot reach it.
 *
 * Mode is inside identity, where it used to be outside. That is a correctness
 * gain (an executable-bit flip is a real content change) and it is free, since
 * `ls-tree` already carries the mode.
 *
 * The name is deliberate: the unified Git content and transaction spec defines
 * a different `treeDigest` over path, **bytes**, and mode. Two different values
 * under one name would produce comparisons that look valid and are not.
 */

declare const PIN: unique symbol;

export interface PinTreeEntry {
  /** Item-relative, POSIX-separated. */
  readonly path: string;
  readonly mode: GitFileMode;
  readonly blobId: string;
  /** Repo-relative path the entry was read from. */
  readonly repoRelPath: string;
}

/**
 * PIN-2: a `(sourcePinDigest, sourceCommit)` pair may be built in exactly one
 * place. `createDataLockEntry` and `refreshDataLockEntry` take this type
 * instead of loose strings, so no call site can assemble a pin from parts.
 *
 * The brand is compile-time pressure, not enforcement: a type assertion, a
 * deserializer, or a second lock serializer can bypass it. What makes it hold
 * is that construction is module-private, the digest is computed inside this
 * module, the entries handed out are frozen, and lock mutation lives in one
 * place.
 */
export interface PinnedSource {
  readonly [PIN]: true;
  readonly sourcePinDigest: string;
  readonly sourceCommit: string;
  readonly entries: readonly PinTreeEntry[];
}

export const PIN_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Human display width. The lock always carries the full digest. */
export function abbreviatePin(digest: string): string {
  return digest.slice(0, 12);
}

/**
 * Abbreviate an identity for a human line, whichever model produced it.
 * A `sourcePinDigest` is a full sha-256 and unreadable in a column; a
 * version-3 `sha` was already 12 characters and passes through unchanged.
 */
export function shortIdentity(value: string | null | undefined): string {
  if (!value) return "(missing)";
  return value.length === 64 ? abbreviatePin(value) : value;
}

/**
 * The digest itself.
 *
 * Sorting is by item-relative name in UTF-16 code-unit order — the same order
 * `hashNamedContents` uses — so two implementations of the same tree cannot
 * disagree because one of them used `localeCompare`.
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
 * Which object-name width this repository uses, inferred from the ids
 * `ls-tree` has just returned rather than from configuration. A SHA-256
 * repository names blobs with 64 hex characters; hardcoding SHA-1 would
 * classify every file in one as modified.
 */
export function hashWidthOf(entries: readonly PinTreeEntry[]): GitHashWidth {
  for (const entry of entries) {
    if (entry.blobId.length === 64) return 64;
    if (entry.blobId.length === 40) return 40;
    throw new Error(`unexpected git object name width: ${entry.blobId}`);
  }
  return 40;
}

/** `<algorithm>("blob " + length + "\0" + bytes)`, Git's own blob naming. */
export function blobIdOf(bytes: Uint8Array, width: GitHashWidth): string {
  const hasher = new Bun.CryptoHasher(width === 64 ? "sha256" : "sha1");
  hasher.update(`blob ${bytes.length}\0`);
  hasher.update(bytes);
  return hasher.digest("hex");
}

/* ------------------------------------------------------------ item trees */

/**
 * The tree entries that make up an item at a commit.
 *
 * `ls-tree -r` covers a copy-directory item directly. The other two shapes
 * name their own path sets, and the digest is taken over exactly those entries
 * at the commit:
 *
 * | kind                                     | tree entries                                       |
 * | ---------------------------------------- | -------------------------------------------------- |
 * | copy-directory (`skills`, `pi-extensions`) | every blob under the item path, sidecar excluded   |
 * | copy-target-file (`subagents`)            | canonical target paths present at the commit       |
 * | fragments (`settings`, `mcp`, `codex-config`) | canonical source paths present at the commit    |
 */
export async function itemTreeEntriesAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
): Promise<PinTreeEntry[]> {
  const itemRoot = itemRepoRelPath(kind, name);
  const pathspecs = isCopyDirectoryItemKind(kind)
    ? [literalPathspec(itemRoot)]
    : allCanonicalItemRelPaths(kind, name).map(literalPathspec);
  const raw = await lsTreeEntriesForPathspecs(dataRepo, commit, pathspecs);
  // Refuses gitlinks and symlinks before they can reach the digest, so a pin
  // can never name something materialization is unable to write.
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

function itemRelativePath(
  itemRoot: string,
  entry: GitTreeEntry,
): string | null {
  const rel = posix.relative(itemRoot, entry.path);
  if (!rel || rel.startsWith("..")) return null;
  // Git paths on Unix are byte strings; `-z` framing makes parsing safe but
  // does not make arbitrary bytes valid UTF-8. A path that does not round-trip
  // is refused with a precise error rather than aliased through replacement
  // characters into a digest that two machines would compute differently.
  if (rel.includes("�")) {
    throw new PreconditionError(
      `${entry.path} does not round-trip through UTF-8; capshelf cannot pin it`,
    );
  }
  return rel;
}

/* -------------------------------------------------------------- pinning */

/** Nothing outside this module may build a `PinnedSource`. */
function brandPin(sourceCommit: string, entries: PinTreeEntry[]): PinnedSource {
  const frozen = Object.freeze(entries.map((entry) => Object.freeze(entry)));
  return Object.freeze({
    sourcePinDigest: sourcePinDigest(frozen),
    sourceCommit,
    entries: frozen,
  }) as unknown as PinnedSource;
}

export interface PinOptions {
  /** Skip PIN-9. Only the one-time `lock migrate` audit path sets this. */
  skipFilterCheck?: boolean;
}

/**
 * Build the pin for an item at a specific commit, refusing anything the design
 * says must never be pinned.
 */
export async function pinItemAtCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  commit: string,
  options: PinOptions = {},
): Promise<PinnedSource> {
  const resolved = await resolveCommit(dataRepo, commit);
  if (resolved === null) {
    throw new PreconditionError(
      `data repo at ${dataRepo} does not contain commit ${commit}`,
    );
  }
  const entries = await itemTreeEntriesAtCommit(dataRepo, kind, name, resolved);
  if (entries.length === 0) {
    throw new Error(
      `${itemRepoRelPath(kind, name)} has no materializable files at ${commit}`,
    );
  }
  if (options.skipFilterCheck !== true) {
    await assertNoExternalFilterDrivers(dataRepo, resolved, [
      { kind, name, entries },
    ]);
  }
  return brandPin(resolved, entries);
}

/**
 * The commit `add`/`update` select for an item: the last commit touching its
 * content. For a copy item the metadata sidecar is excluded, so a
 * sidecar-only commit never moves the pin.
 */
export async function currentSourceCommit(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string> {
  if (isCopyDirectoryItemKind(kind)) {
    return await lastTouchingContentCommit(
      dataRepo,
      itemRepoRelPath(kind, name),
    );
  }
  if (isCopyTargetFileItemKind(kind) || isFragmentItemKind(kind)) {
    return await lastTouchingCommitForPaths(
      dataRepo,
      allCanonicalItemRelPaths(kind, name),
    );
  }
  throw new Error(`no pin strategy for ${kind}/${name}`);
}

/** `currentSourceCommit` followed by `pinItemAtCommit`. */
export async function pinCurrentSource(
  dataRepo: string,
  kind: ItemKind,
  name: string,
  options: PinOptions = {},
): Promise<PinnedSource> {
  return await pinItemAtCommit(
    dataRepo,
    kind,
    name,
    await currentSourceCommit(dataRepo, kind, name),
    options,
  );
}

/* ------------------------------------------------------------- PIN-9 */

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
 * PIN-9: no managed path may declare an external filter driver.
 *
 * Under tree identity capshelf faithfully delivers what Git stores. For Git's
 * own transformations that is the right answer — a `core.autocrlf=input`
 * repository *does* hold LF, and every clone produces LF, so LF is the
 * content. For an external filter driver it is the wrong answer: what Git
 * stores is a pointer or ciphertext standing in for content that lives
 * elsewhere, and it would be delivered consistently, and consistently wrong,
 * to every consumer.
 *
 * Tree identity makes this rule *more* important than it was: the working-tree
 * design would have caught an active driver by accident, through a byte
 * mismatch. This one delivers the stored bytes faithfully and would never
 * notice.
 *
 * The scope is deliberately narrow. `text`, `eol`, `ident`, and
 * `working-tree-encoding` are applied by Git itself in every clone, so
 * refusing on their declaration would reject legitimate repositories.
 */
export async function filteredPathsAtCommit(
  dataRepo: string,
  commit: string,
  subjects: readonly FilterCheckSubject[],
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
  const results = await checkAttrAtCommit(dataRepo, commit, paths, ["filter"]);
  const filtered: FilteredPath[] = [];
  for (const result of results) {
    if (result.attribute !== "filter") continue;
    // `unspecified`, `unset`, and `set` are not driver names. Only a real
    // driver name means Git hands the bytes to an external program.
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
): Promise<void> {
  const filtered = await filteredPathsAtCommit(dataRepo, commit, subjects);
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
 * Group items by their source commit so a multi-item command makes one
 * attribute query per distinct commit rather than one per item. No call mixes
 * attribute sources.
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

/* ------------------------------------------------- installed comparison */

export interface InstalledEntryObservation {
  path: string;
  /** Absent from the install. */
  missing?: true;
  /** Present but not a regular file, or unreadable. */
  unusable?: "unsupported-type" | "unreadable";
  mode?: GitFileMode;
  blobId?: string;
  bytes?: Buffer;
}

/**
 * PIN-6 stage 1: read the installed files and name them the way Git would,
 * without reading a single pinned blob. A clean project therefore settles its
 * whole installation axis with zero object reads; stage 2 fetches blobs only
 * for the paths already known to differ, which is the same set `--diff`
 * renders.
 *
 * Leaf reads are opened once and revalidated. `lstat`-then-`readFile` leaves a
 * window in which the leaf can become a symlink, so each file is opened with
 * `O_NOFOLLOW` and then `fstat`-ed and read through that descriptor. This
 * closes leaf substitution. It does not close concurrent replacement of an
 * ancestor directory, which is outside this design's threat model.
 */
export interface InstalledTarget {
  /** The pinned entry's item-relative name. */
  path: string;
  /** Where that entry lives in the project. */
  absolutePath: string;
}

/**
 * The default mapping: a copy-directory item installs its tree verbatim under
 * one root. Subagents map each canonical source to its own output file, so
 * they build their targets themselves.
 */
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        out.push({ path: entry.path, missing: true });
        continue;
      }
      // ELOOP is the O_NOFOLLOW refusal; EISDIR is a directory where a file is
      // pinned. Both are "capshelf must not overwrite this".
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
 * The installed tree's identity, in the same shape as `sourcePinDigest`, so a
 * clean install digests to exactly the pin. An absent or unusable path is
 * given a sentinel that no real entry can produce, which keeps the comparison
 * total instead of silently narrowing the set that feeds the hash.
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

/* --------------------------------------------------------- materializing */

export interface PinnedBytes {
  path: string;
  mode: GitFileMode;
  content: Buffer;
}

/**
 * PIN-3: every command that writes managed files reads bytes the same way —
 * the pin's blob ids through one `cat-file --batch`. `add` used to copy the
 * data repo working tree while `apply` read the commit, and the asymmetry is
 * what made the original bug invisible from inside the project.
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
): Promise<PinnedBytes[]> {
  const blobs = await catFileBlobs(
    dataRepo,
    entries.map((entry) => entry.blobId),
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

/* --------------------------------------------------------------- PIN-11 */

export interface CommitProofMismatch {
  path: string;
  /** Blob id of what the project held, or null when the project had no such path. */
  project: string | null;
  /** Blob id of what the commit holds, or null when the commit has no such path. */
  committed: string | null;
}

/**
 * PIN-11: prove the project snapshot equals the committed tree.
 *
 * Let `A` be the snapshot `promote`/`share` read from the project. It is
 * copied into the data repo worktree, staged, and committed — and Git or the
 * repository's own policy may turn `A` into `B` in between: a clean filter, a
 * formatter in a `pre-commit` hook, a nested `.gitattributes` that arrived with
 * the copy, or an ignore rule that drops a file from a broad `git add`. A
 * destination-side check then compares `B` with the commit it produced, which
 * agree, and capshelf publishes content the project never held.
 *
 *     A == B                    project snapshot equals the committed tree
 *     B == tree at newCommit    the commit is what was staged
 *     ────────────────────────
 *     ⇒ sourcePinDigest(B) describes what the project actually holds
 *
 * `A`'s ids are computed in process from the project's own bytes, using the
 * width the committed tree reports, so a SHA-256 repository compares correctly
 * without asking Git what format it uses.
 */
/**
 * Name a set of project files the way `ls-tree` names a committed tree, so the
 * two can be digested with the same formula. Used where the question is "does
 * what the project holds already equal the pin?".
 */
export function projectTreeEntries(
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

export function compareProjectToCommit(
  projectFiles: ReadonlyArray<{
    path: string;
    mode: GitFileMode;
    content: Buffer;
  }>,
  committed: readonly PinTreeEntry[],
): CommitProofMismatch[] {
  const width = hashWidthOf(committed);
  const projectIds = new Map(
    projectFiles.map((file) => [
      file.path,
      `${file.mode}:${blobIdOf(file.content, width)}`,
    ]),
  );
  const committedIds = new Map(
    committed.map((entry) => [entry.path, `${entry.mode}:${entry.blobId}`]),
  );
  const mismatches: CommitProofMismatch[] = [];
  for (const path of new Set([...projectIds.keys(), ...committedIds.keys()])) {
    const left = projectIds.get(path) ?? null;
    const right = committedIds.get(path) ?? null;
    if (left === right) continue;
    mismatches.push({
      path,
      project: left?.split(":")[1] ?? null,
      committed: right?.split(":")[1] ?? null,
    });
  }
  return mismatches.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function commitProofRefusalMessage(
  ref: string,
  mismatches: readonly CommitProofMismatch[],
): string {
  const width = Math.max(...mismatches.map((entry) => entry.path.length));
  return [
    `not publishing ${ref}`,
    "  the committed content is not the content this project holds",
    "",
    ...mismatches.map(
      (entry) =>
        `    ${entry.path.padEnd(width)}    project ${abbreviatePin(entry.project ?? "(absent)")}   committed ${abbreviatePin(entry.committed ?? "(absent)")}`,
    ),
    "",
    "  something between the copy and the commit rewrote the file — a pre-commit",
    "  hook, a clean filter, or a .gitattributes rule in the data repo",
    "  the data repo was rolled back; nothing was published",
  ].join("\n");
}

/* --------------------------------------------------------------- PIN-10 */

export interface NameCollision {
  key: string;
  paths: string[];
}

/**
 * PIN-10: the tree is case-sensitive and byte-addressed; the destination may
 * be neither. Two pinned paths differing only in case, or in Unicode
 * normalization, collapse onto one file on APFS or NTFS — the install then
 * holds one file where the tree holds two, and every later comparison reads
 * the same bytes under two names.
 *
 * The key comes from a measurement, not from assumed folding rules:
 * lowercasing plus NFC is a guess about the filesystem and it is wrong in both
 * directions. `caseFolding` and `normalizationFolding` come from probing the
 * destination, and the probe is skipped entirely when no two pinned paths
 * could collide under either rule — which is almost every item.
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

/** True when some pair of paths could fold together under *either* rule. */
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
 * Measure the destination's name-folding behavior in a temporary sibling
 * directory: write one probe name, then ask whether the case-flipped and
 * normalization-flipped forms resolve to it.
 *
 * Two booleans, both observed. `.toLowerCase() + NFC` as an assumption
 * over-folds on a case-sensitive volume (refusing an item that installs fine)
 * and under-folds on a filesystem with its own equivalence rules (accepting
 * one that does not).
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
    // Unwritable parent: the write itself will fail with a better error.
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

/**
 * The complete PIN-10 check for one destination: skip the probe unless two
 * pinned paths could fold together, then refuse on a real collision.
 */
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
