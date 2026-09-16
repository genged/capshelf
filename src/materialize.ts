import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { entryIdentity } from "./lock";
import type { DataLockEntry, LockEntry } from "./lock";
import type { Manifest } from "./manifest";
import {
  assertCanMaterializeInstalled,
  ensureInstallAliases,
  parseLockKey,
  installedPath,
} from "./installed";
import type { ItemSource } from "./installed";
import { isTreePinned } from "./install-identity";
import { isGitTree, sameContentSource } from "./item-source";
import type { ContentSource, GitTreeSource } from "./item-source";
import type { ItemKind, CopyDirectoryItemKind } from "./master";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isMetadataSidecarPath,
} from "./master";
import { hashNamedContents } from "./content-hash";
import type { Scope } from "./promote-core";
import { findSystemItem, shaOfSystemItem } from "./bundled";
import {
  abbreviatePin,
  hashWidthOf,
  installedPinDigest,
  itemTreeEntriesAtCommit,
  readEntryBytes,
  sourcePinDigest,
  targetsUnderRoot,
} from "./pin";
import type { PinTreeEntry } from "./pin";
import { runtimeWarningsForItem } from "./runtime-warnings";
import type { RuntimeWarning } from "./runtime-warnings";
import { missingSourceCommitMessage } from "./upstream-check";
import type { NamedFile } from "./merge-tree";
import { namedFilesEqual } from "./merge-tree";
import { gitignoreVisibleFiles, inventoryLocalTree } from "./gitignore";
import { gitPolicyVisiblePathsUnderPath } from "./git";
import { beginDirectoryReplacement } from "./promote-transaction";
import { shaOfNamedFiles } from "./item-snapshot";
import { PRODUCT_NAME } from "./identity";
import { PreconditionError } from "./errors";
import { assertSafeItemName } from "./assert";
import { isErrno } from "./fs-utils";
import { findDestinationPathCollision } from "./path-collision";

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
  plannedSha?: string | null;
  dryRun?: true;
  message?: string;
  runtimeWarnings?: RuntimeWarning[];
}

export interface MaterializeHooks {
  beforeSourceRead?: (path: string, index: number) => Promise<void>;
  beforeStagedWrite?: (path: string, index: number) => Promise<void>;
  afterStagedWrite?: (path: string, index: number) => Promise<void>;
  beforeStagedChmod?: (path: string, index: number) => Promise<void>;
  afterStagedChmod?: (path: string, index: number) => Promise<void>;
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
}

/**
 * A lock entry and the content source its bytes are read through. The two
 * travel together so a caller cannot hand one function an entry and another
 * entry's source.
 */
export interface SourcedEntry {
  entry: LockEntry;
  source: ContentSource;
}

export interface MaterializeOptions {
  project: string;
  source: ContentSource;
  manifest?: Manifest;
  /**
   * The item this writes. It used to be parsed out of `key`, which forced every
   * writer to hold a capshelf lock key; a record kept in another document has
   * none, and its identity key is not what selects the item.
   */
  kind: ItemKind;
  name: string;
  /** The row identity, carried into the result. */
  key: string;
  entry: LockEntry;
  /** Previous lock snapshot used to distinguish stale managed paths from
   * ignored local-only files while replacing a directory. */
  previous?: SourcedEntry;
  /**
   * Lock scope the entry came from — not inferable from `entry.local`, which
   * records intentional divergence. Local-scope installs are Git-excluded, so
   * their current-state hashing must not consult project Git visibility.
   */
  scope: Scope;
  ignoreLocal?: boolean;
  dryRun?: boolean;
  hooks?: MaterializeHooks;
}

/**
 * Row 4 of the object-model table in `master.ts`: ignored local state under a
 * managed directory, carried across a directory replacement as-is. This is
 * deliberately not `NamedFile` — these paths never cross a Git boundary, so
 * they keep their real `stat` mode instead of collapsing to `100644`/`100755`,
 * and a symlink is recreated by target rather than refused. `NamedFile` stays
 * the Git-boundary type shared with merge-tree, promote, and the tree code.
 */
export type PreservedEntry =
  | { kind: "file"; path: string; content: Buffer; mode: number }
  | { kind: "symlink"; path: string; target: string };

export interface CopyDirectoryReconciliationFiles {
  /** Rows 1–3: managed content, Git modes, Git rules. */
  expected: NamedFile[];
  /** Rows 4–5. */
  preserved: PreservedEntry[];
  /** The pinned tree entries `expected` was read from; empty for a system item. */
  entries: readonly PinTreeEntry[];
}

export async function materializeLockEntry(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  // `key` answers "which row is this", and the caller answers "which item does
  // this write". The name check moves with the second question: `parseLockKey`
  // still validates the key it is given, but it no longer sees the name that
  // reaches `installedPath`.
  const { source: keySource } = parseLockKey(opts.key);
  const { kind, name } = opts;
  assertSafeItemName(name, `${kind} item`);
  if (isFragmentItemKind(kind)) {
    throw new Error(
      `${kind}/${name} is a fragment item and must be reconciled through fragment outputs`,
    );
  }
  if (isCopyTargetFileItemKind(kind)) {
    throw new Error(
      `${kind}/${name} must be reconciled through copy-target-file outputs`,
    );
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no materialization strategy for ${kind}/${name}`);
  }
  const dst = installedPath(opts.project, kind, name);

  if (opts.entry.source !== keySource) {
    throw new Error(
      `lock key ${opts.key} source does not match entry source ${opts.entry.source}`,
    );
  }

  const previous: SourcedEntry = opts.previous ?? {
    entry: opts.entry,
    source: opts.source,
  };

  if (
    opts.entry.source === "data" &&
    opts.entry.local === true &&
    !opts.ignoreLocal
  ) {
    return {
      key: opts.key,
      source: keySource,
      kind,
      name,
      action: "kept-local",
      path: dst,
      sha: await installedIdentityForEntry(
        dst,
        opts.entry,
        await itemContentForSource(
          opts.source,
          kind,
          name,
          opts.manifest,
        ).catch(() => null),
      ),
      message: opts.entry.localReason,
      ...runtimeWarningFields(opts.project, kind, name),
    };
  }

  if (isGitTree(opts.source)) {
    assertCanMaterializeInstalled(opts.project, kind, name);
  } else {
    const item = findSystemItem(name);
    if (!item || item.kind !== kind) {
      throw new Error(`system item no longer bundled: ${kind}/${name}`);
    }
    assertCanMaterializeInstalled(opts.project, kind, name);
    // The one bundle-versus-lock check for a system item, and the reason
    // `copyDirectoryReconciliationFiles` does not repeat it. Superseded bundled
    // content is unrecoverable by design, so this cannot be repaired by
    // retrying — say what the state is and name the command that re-pins it.
    const sourceSha = await shaOfSystemItem(item);
    if (sourceSha !== opts.source.sha) {
      throw new Error(
        `bundled ${kind}/${name} in this ${PRODUCT_NAME} binary hashes to ${sourceSha}, but lock expects ${opts.source.sha}; superseded bundled content is not recoverable — run \`${PRODUCT_NAME} update ${kind}/${name}\` to re-pin the item to the bundled content this binary carries`,
      );
    }
  }
  const reconciliationFiles = await copyDirectoryReconciliationFiles({
    project: opts.project,
    source: opts.source,
    manifest: opts.manifest,
    kind,
    name,
    entry: opts.entry,
    previous,
    scope: opts.scope,
    hooks: opts.hooks,
  });

  // PIN-5: the installed identity is filesystem work over the *managed* path
  // set. It used to route through project Git, which meant an edit to the
  // project's `.gitignore` could move an item's computed state and a
  // `--local` item — deliberately listed in `.git/info/exclude` — hashed as if
  // it were empty.
  // Reported as `current:` next to `planned:`, so it names the install in the
  // model of the entry the install was written from — the previous pin when
  // there is one. Naming it in the incoming entry's model instead would make
  // an untouched install look drifted for the ordinary reason that the
  // upstream content changed.
  const before = await installedIdentityForEntry(
    dst,
    previous.entry,
    previous.entry === opts.entry
      ? {
          entries: reconciliationFiles.entries,
          files: reconciliationFiles.expected,
        }
      : await itemContentForSource(
          previous.source,
          kind,
          name,
          opts.manifest,
        ).catch(() => null),
  );
  const dataBeforeMatches = await installedFilesMatch(
    dst,
    reconciliationFiles.expected,
    reconciliationFiles.preserved,
  );
  if (!opts.dryRun && !dataBeforeMatches) {
    await materializeCopyDirectory(
      opts.project,
      kind,
      name,
      reconciliationFiles,
      opts.hooks,
    );
  } else if (!opts.dryRun) {
    await ensureInstallAliases(opts.project, kind, name);
  }

  // The transactional writer verifies both selected managed bytes and copied-
  // forward local bytes. The reported sha remains the selected lock sha;
  // intentionally ignored local-only files are outside that content identity.
  //
  // `dataBeforeMatches` is the only convergence signal, deliberately: it byte-
  // compares every expected and preserved path. Comparing the Git-visible
  // installed sha against the lock sha instead would report permanent
  // `would-reconcile` for any item whose managed content includes paths the
  // project's own .gitignore hides, making --dry-run disagree with apply.
  const changed = !dataBeforeMatches;
  return {
    key: opts.key,
    source: keySource,
    kind,
    name,
    action: opts.dryRun
      ? changed
        ? "would-reconcile"
        : "already-current"
      : changed
        ? "reconciled"
        : "already-current",
    path: dst,
    sha: opts.dryRun ? before : entryIdentity(opts.entry),
    ...(opts.dryRun && {
      currentSha: before,
      plannedSha: entryIdentity(opts.entry),
      dryRun: true as const,
    }),
    ...runtimeWarningFields(opts.project, kind, name),
  };
}

/**
 * PIN-5's classifier for *unpinned* paths under an installed item.
 *
 * | destination                        | classifier                                                          |
 * | ---------------------------------- | ------------------------------------------------------------------- |
 * | project scope in a Git worktree    | project Git, with the complete ignore stack                          |
 * | local scope                        | the item-root ignore walker — capshelf excludes the whole local item |
 * | project scope outside Git          | the item-root ignore walker                                          |
 *
 * Reimplementing Git's ignore stack in process was rejected: exact parity needs
 * nested and parent `.gitignore` files, `.git/info/exclude`,
 * `core.excludesFile`, negation, directory pruning, and the tracked-file rule.
 * Git owns that policy and answers it exactly. Using project Git for *every*
 * scope is equally wrong: capshelf puts a local-scope item in
 * `.git/info/exclude`, so project Git sees the whole item as ignored and cannot
 * tell a user-owned extra from a visible one.
 *
 * A project ignore edit may therefore move an extra between visible and
 * ignored. That is intentional — it changes who owns an unpinned file, not what
 * the lock manages.
 */
async function visibleExtraPaths(
  project: string,
  root: string,
  extras: readonly string[],
  scope: Scope,
): Promise<Set<string>> {
  if (extras.length === 0) return new Set();
  const candidates = new Set(extras);
  const gitPolicyPaths =
    scope === "project"
      ? await gitPolicyVisiblePathsUnderPath(project, relative(project, root))
      : null;
  const visible =
    gitPolicyPaths ??
    // Outside project Git the fallback walker still does not consult parent
    // ignore files, `.git/info/exclude`, or `core.excludesFile`. That
    // limitation now applies only where no usable project Git policy exists.
    (await gitignoreVisibleFiles(root).catch(() => [...candidates]));
  return new Set(visible.filter((path) => candidates.has(path)));
}

/**
 * The installed identity of a copy-directory item, expressed in whichever
 * model the entry itself uses, so `currentSha` and `plannedSha` in a report are
 * always comparable values rather than two different kinds of hash.
 *
 * Version 4 names the install the way Git names a tree — a blob id and mode per
 * pinned path — so a clean install digests to exactly `sourcePinDigest`.
 * Version 3 and system entries keep the legacy content hash over the same
 * managed path set.
 */
async function installedIdentityForEntry(
  root: string,
  entry: LockEntry,
  content: { entries: readonly PinTreeEntry[]; files: NamedFile[] } | null,
): Promise<string | null> {
  if (content === null || !existsSync(root)) return null;
  if (isTreePinned(entry)) {
    return await installedPinDigest(
      targetsUnderRoot(root, content.entries),
      hashWidthOf(content.entries),
    );
  }
  // Legacy model: hash the managed paths that are actually present, which is
  // what the version-3 install hash always did — an absent managed file simply
  // does not participate, and the resulting mismatch is the drift signal.
  const present: Array<{ name: string; content: Buffer }> = [];
  for (const file of content.files) {
    const fullPath = join(root, ...file.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null || !stats.isFile()) continue;
    present.push({ name: file.path, content: await readFile(fullPath) });
  }
  return hashNamedContents(present);
}

export async function copyDirectoryReconciliationFiles(opts: {
  project: string;
  source: ContentSource;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
  entry: LockEntry;
  previous: SourcedEntry;
  scope: Scope;
  hooks?: MaterializeHooks;
}): Promise<CopyDirectoryReconciliationFiles> {
  const content = await itemContentForSource(
    opts.source,
    opts.kind,
    opts.name,
    opts.manifest,
    opts.hooks,
  );
  const expected = content.files;
  // Only a data entry carries a retrieval to verify: its files are read back
  // from `sourceCommit`, so a mismatch means the retrieval returned the wrong
  // bytes. A system entry has no retrieval — `filesForEntry` returns the
  // running binary's bundled tree whatever the entry says — so comparing that
  // tree to `entry.sha` does not check anything this function did. It asks
  // whether the current bundle happens to be the one the entry pins, which is
  // the caller's policy question: `materializeLockEntry` answers it above,
  // before any write, and `planCopyDirectoryDestruction` must be able to plan
  // against a superseded entry without it. `sameSourceContent` below states the
  // same assumption for the previous-entry read.
  //
  // Two halves, deliberately: the source says a retrieval happened, and the
  // entry says which recorded identity to check it against. A bundled source
  // retrieves nothing, and a system entry records no source identity.
  if (isGitTree(opts.source) && opts.entry.source === "data") {
    // The entries were read by the call above and cached with the bytes, so
    // verification adds no subprocess: version 4 digests what is already in
    // hand, and version 3 hashes the bytes it already holds.
    assertSourceMatchesEntry(
      opts.kind,
      opts.name,
      opts.entry,
      content.entries,
      expected,
    );
  }

  const dst = installedPath(opts.project, opts.kind, opts.name);
  if (!existsSync(dst)) {
    return { expected, preserved: [], entries: content.entries };
  }

  // Reading the previous tree is one `git ls-tree` plus one `git show` per
  // file. `apply` and `revert` always pass the same entry twice, so aliasing
  // rather than re-reading removes half the source reads on those paths.
  //
  // PIN-8: the previous entry is not this function's target — it only names
  // which installed paths were managed before, so ignored local state can be
  // told apart from stale managed content. An unresolvable previous pin (a
  // garbage-collected commit, a contradictory digest) therefore degrades to
  // "nothing was managed before" rather than failing the command that is
  // trying to replace it. The consequence is that a stale managed path the
  // project ignores is preserved instead of deleted, which is the safe
  // direction, and every Git-visible one still reaches the consent boundary.
  const previous = sameContentSource(opts.source, opts.previous.source)
    ? expected
    : await itemContentForSource(
        opts.previous.source,
        opts.kind,
        opts.name,
        opts.manifest,
      ).then(
        (content) => content.files,
        () => [],
      );
  const previousPaths = new Set(previous.map((file) => file.path));
  // PIN-5's set operation. The pinned path set is always managed — an ignore
  // rule cannot hide a pinned path or change its drift result — so only the
  // *extras* are classified, and only they can be owned by the user.
  const managedPaths = new Set([
    ...expected.map((file) => file.path),
    ...previousPaths,
  ]);
  const inventory = await inventoryLocalTree(dst);
  const extras = [
    ...inventory.files,
    ...inventory.irregular.map((object) => object.path),
  ].filter((path) => !managedPaths.has(path));
  const visibleExtras = await visibleExtraPaths(
    opts.project,
    dst,
    extras,
    opts.scope,
  );
  const preserved: PreservedEntry[] = [];
  for (const path of inventory.files) {
    // Row 5: the sidecar is excluded from hashing and materialization
    // everywhere, so it is carried across regardless of Git visibility. Every
    // other Git-visible extra is row 3 — drift the caller reconciles away.
    if (!isMetadataSidecarPath(path) && visibleExtras.has(path)) continue;
    if (managedPaths.has(path)) continue;
    const fullPath = join(dst, ...path.split("/"));
    const info = await lstat(fullPath);
    preserved.push({
      kind: "file",
      path,
      content: await readFile(fullPath),
      mode: info.mode & 0o7777,
    });
  }
  for (const object of inventory.irregular) {
    // A non-recreatable object is refused whatever its ignore status: a
    // directory replacement cannot put a fifo, socket, or device node back,
    // and deleting one silently is not a thing consent can authorize.
    if (object.type !== "symlink") {
      throw new PreconditionError(
        `${dst} contains an unsupported filesystem object: ${object.path}; fifos, sockets, and device nodes cannot be recreated by a directory replacement`,
        {
          hint: `Remove or relocate the path, then rerun the command. \`${PRODUCT_NAME} rm\` can still delete the item with it in place.`,
        },
      );
    }
    // A Git-visible symlink is an extra the project owns through its own
    // policy, so reconciliation removes it (row 3) rather than carrying it.
    if (visibleExtras.has(object.path)) continue;
    if (managedPaths.has(object.path)) continue;
    const fullPath = join(dst, ...object.path.split("/"));
    preserved.push({
      kind: "symlink",
      path: object.path,
      target: await readlink(fullPath),
    });
  }

  await assertNoPreservedPathCollisions({
    destination: dst,
    preserved,
    expected,
    kind: opts.kind,
    name: opts.name,
  });

  return {
    expected,
    entries: content.entries,
    preserved: preserved.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export async function assertNoPreservedPathCollisions(opts: {
  destination: string;
  preserved: readonly PreservedEntry[];
  expected: readonly NamedFile[];
  kind: CopyDirectoryItemKind;
  name: string;
}): Promise<void> {
  const collision = await findDestinationPathCollision(
    opts.destination,
    opts.preserved.map((entry) => entry.path),
    opts.expected.map((file) => file.path),
  );
  if (!collision) return;
  throw new PreconditionError(
    `ignored local path ${collision.left} collides with selected managed path ${collision.right} in ${opts.kind}/${opts.name}`,
    {
      hint: "Move or rename the local-only path, then review the item and rerun the command.",
    },
  );
}

/**
 * The managed file set a lock entry selects, without touching the project.
 * Removal planning needs it to tell managed content apart from local state,
 * but must not depend on the reconciliation preflight: `rm` has to work when
 * the data repo is gone or the source commit was garbage-collected.
 */
export async function lockedCopyDirectoryFiles(opts: {
  source: ContentSource;
  manifest?: Manifest;
  kind: CopyDirectoryItemKind;
  name: string;
}): Promise<NamedFile[]> {
  return (
    await itemContentForSource(opts.source, opts.kind, opts.name, opts.manifest)
  ).files;
}

/**
 * Item content at a commit, memoized for the life of the process.
 *
 * A commit's tree is immutable and content-addressed, so a second read can
 * only ever return the same bytes. Without this, one `apply` reads the whole
 * source tree once per plan/revalidate/materialize pass and once per planner
 * within each — one `git ls-tree` plus one `git show` per file, every time.
 * The local filesystem is deliberately NOT cached: revalidation exists to
 * notice that it changed.
 *
 * Peak memory becomes the managed content one command touches rather than one
 * item's worth; for the item kinds capshelf manages that is kilobytes.
 */
const atCommitFiles = new Map<string, CommitItemContent>();

async function _readDataFilesAtCommit(
  source: GitTreeSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
): Promise<NamedFile[]> {
  return (await readItemContentAtCommit(source, kind, name, manifest, hooks))
    .files;
}

interface CommitItemContent {
  entries: PinTreeEntry[];
  files: NamedFile[];
}

/**
 * PIN-3: one `ls-tree` for the entries, one `cat-file --batch` for the bytes.
 *
 * `cat-file` reads objects directly and applies no smudge filter, so what
 * lands in the project is exactly what the commit holds — and, because `add`
 * now comes through here too, byte-identical to what `apply` writes by
 * construction rather than by agreement.
 */
async function readItemContentAtCommit(
  source: GitTreeSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
): Promise<CommitItemContent> {
  // The item root is part of the key, so a read at a root other than the
  // canonical one cannot collide with a canonical read of the same commit.
  const cacheKey = `${source.repo}\0${source.commit}\0${source.itemRoot}`;
  const cached = atCommitFiles.get(cacheKey);
  if (cached) {
    // Hooks still fire on a cache hit: they are how the transaction tests
    // inject a failure at a specific source read, and skipping them would
    // make a cached pass behave differently from a cold one.
    for (const [index, entry] of cached.entries.entries()) {
      await hooks?.beforeSourceRead?.(entry.repoRelPath, index);
    }
    // A fresh array per caller, on both the hit and the miss path: the entries
    // are immutable content, but callers own their list and one of them
    // sorting in place must not reorder another's.
    return { entries: [...cached.entries], files: [...cached.files] };
  }

  let entries: PinTreeEntry[];
  try {
    entries = await itemTreeEntriesAtCommit(source, kind);
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throwMissingCommit(source.repo, manifest, source.commit, { kind, name });
  }
  if (entries.length === 0) {
    throw new Error(
      `${source.itemRoot} has no materializable files at ${source.commit}`,
    );
  }
  for (const [index, entry] of entries.entries()) {
    await hooks?.beforeSourceRead?.(entry.repoRelPath, index);
  }
  let files: NamedFile[];
  try {
    files = (await readEntryBytes(source.repo, entries)).map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.mode,
    }));
  } catch {
    throwMissingCommit(source.repo, manifest, source.commit, { kind, name });
  }
  const content: CommitItemContent = { entries, files };
  atCommitFiles.set(cacheKey, content);
  return { entries: [...entries], files: [...files] };
}

/**
 * The one place a data entry's recorded identity is checked against what the
 * repository actually holds.
 *
 * Version 4 compares the committed tree's `sourcePinDigest` — no file content
 * is read to answer it, and no working-tree state can change the answer.
 * Version 3 keeps the legacy working-tree hash so a project that has not run
 * `lock migrate` can still `apply`; the two are never mixed, because a lock
 * file carries exactly one of them.
 */
function assertSourceMatchesEntry(
  kind: CopyDirectoryItemKind,
  name: string,
  entry: DataLockEntry,
  entries: readonly PinTreeEntry[],
  expected: NamedFile[],
): void {
  if (entry.sourcePinDigest !== undefined) {
    const digest = sourcePinDigest(entries);
    if (digest === entry.sourcePinDigest) return;
    throw new Error(
      `source ${kind}/${name} at ${entry.sourceCommit} pins to ${abbreviatePin(digest)}, but lock expects ${abbreviatePin(entry.sourcePinDigest)}\n` +
        `  ${unprovablePinGuidance(kind, name)}`,
    );
  }
  const sourceSha = shaOfNamedFiles(expected);
  if (sourceSha === entry.sha) return;
  throw new Error(
    `source ${kind}/${name} at ${entry.sourceCommit} hashes to ${sourceSha}, but lock expects ${entry.sha}\n` +
      `  ${unprovablePinGuidance(kind, name)}`,
  );
}

async function materializeCopyDirectory(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  files: CopyDirectoryReconciliationFiles,
  hooks?: MaterializeHooks,
): Promise<void> {
  const dst = installedPath(project, kind, name);
  assertCanMaterializeInstalled(project, kind, name);
  const transaction = await beginDirectoryReplacement(dst, async (staged) => {
    for (const [index, file] of files.expected.entries()) {
      const out = join(staged, ...file.path.split("/"));
      await mkdir(dirname(out), { recursive: true });
      await hooks?.beforeStagedWrite?.(file.path, index);
      await writeFile(out, file.content);
      await hooks?.afterStagedWrite?.(file.path, index);
      const mode = fileModeFromGit(file.mode);
      await hooks?.beforeStagedChmod?.(file.path, index);
      await chmod(out, mode);
      await hooks?.afterStagedChmod?.(file.path, index);
    }
    for (const entry of files.preserved) {
      const out = join(staged, ...entry.path.split("/"));
      await mkdir(dirname(out), { recursive: true });
      if (entry.kind === "symlink") {
        await symlink(entry.target, out);
        continue;
      }
      await writeFile(out, entry.content);
      await chmod(out, entry.mode);
    }
    await hooks?.beforePublish?.();
  });
  try {
    await hooks?.afterPublish?.();
    if (!(await installedFilesMatch(dst, files.expected, files.preserved))) {
      throw new Error(
        `materialized ${kind}/${name} does not match the staged regular-file tree`,
      );
    }
    await ensureInstallAliases(project, kind, name);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * The managed files a content source selects. The repository, the commit, and
 * the root are inside the source, so an ambient `dataRepo` argument can no
 * longer disagree with the entry that named it.
 */
async function itemContentForSource(
  source: ContentSource,
  kind: CopyDirectoryItemKind,
  name: string,
  manifest?: Manifest,
  hooks?: MaterializeHooks,
): Promise<CommitItemContent> {
  if (isGitTree(source)) {
    return await readItemContentAtCommit(source, kind, name, manifest, hooks);
  }
  const item = findSystemItem(name);
  if (!item || item.kind !== kind) {
    throw new Error(`system item no longer bundled: ${kind}/${name}`);
  }
  // A system item has no commit and therefore no tree entries: its identity
  // stays the bundled `sha`, checked by `materializeLockEntry` before any
  // write.
  return {
    entries: [],
    files: item.files
      .map((file) => ({
        path: file.relPath,
        content: Buffer.from(file.content),
        mode: "100644" as const,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function runtimeWarningFields(
  project: string,
  kind: ItemKind,
  name: string,
): Pick<MaterializeResult, "runtimeWarnings"> {
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
  return runtimeWarnings.length > 0 ? { runtimeWarnings } : {};
}

function throwMissingCommit(
  dataRepo: string,
  manifest: Manifest | undefined,
  commit: string,
  item?: { kind: CopyDirectoryItemKind; name: string },
): never {
  const detail = manifest
    ? missingSourceCommitMessage(dataRepo, commit, manifest)
    : `data repo at ${dataRepo} does not contain commit ${commit}`;
  throw new Error(
    item
      ? `${detail}\n  ${unprovablePinGuidance(item.kind, item.name)}`
      : detail,
  );
}

/**
 * PIN-8. `apply` and `revert` take the locked commit as their target, so they
 * cannot repair a pin that commit does not support: consent cannot create
 * missing bytes or choose between two contradictory identities. `update`
 * selects a new commit, which is a verified target, so it can.
 */
function unprovablePinGuidance(
  kind: CopyDirectoryItemKind,
  name: string,
): string {
  return `the locked source cannot supply a verified target — repair the pin with: ${PRODUCT_NAME} update ${kind}/${name}`;
}

function fileModeFromGit(mode: string): number {
  switch (mode) {
    case "100644":
      return 0o644;
    case "100755":
      return 0o755;
    default:
      throw new Error(`unsupported regular-file mode: ${mode}`);
  }
}

async function installedFilesMatch(
  root: string,
  expected: NamedFile[],
  preserved: PreservedEntry[] = [],
): Promise<boolean> {
  if (!existsSync(root)) return false;
  const knownPaths = new Set([
    ...expected.map((file) => file.path),
    ...preserved.map((entry) => entry.path),
  ]);
  for (const path of await gitignoreVisibleFiles(root)) {
    // The sidecar is catalog data, never managed content and never drift.
    if (isMetadataSidecarPath(path)) continue;
    if (!knownPaths.has(path)) return false;
  }
  const current: NamedFile[] = [];
  for (const file of expected) {
    const fullPath = join(root, ...file.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null || !stats.isFile()) return false;
    current.push({
      path: file.path,
      content: await readFile(fullPath),
      mode: (stats.mode & 0o111) !== 0 ? "100755" : "100644",
    });
  }
  if (!namedFilesEqual(current, expected)) return false;

  for (const entry of preserved) {
    const fullPath = join(root, ...entry.path.split("/"));
    const stats = await lstatOrNullAsync(fullPath);
    if (stats === null) return false;
    if (entry.kind === "symlink") {
      if (!stats.isSymbolicLink()) return false;
      if ((await readlink(fullPath)) !== entry.target) return false;
      continue;
    }
    if (!stats.isFile()) return false;
    if ((stats.mode & 0o7777) !== entry.mode) return false;
    if (!(await readFile(fullPath)).equals(entry.content)) return false;
  }
  return true;
}

async function lstatOrNullAsync(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}
