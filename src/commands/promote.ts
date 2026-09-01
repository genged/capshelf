import type { Command } from "commander";
import { printShareUpstreamGuidance } from "./share";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { atomicWriteFile, lstatOrNull } from "../fs-utils";
import { homeRelative, shellArg } from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  assertLockV4,
  dataKey,
  refreshDataLockEntry,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntryV4, LockV4 } from "../lock";
import {
  hashWidthOf,
  itemTreeEntriesAtCommit,
  namedFilesTreeEntries,
  pinItemAtCommit,
  sourcePinDigest,
} from "../pin";
import type { PinnedSource } from "../pin";
import { assertCommittedTreeEqualsCandidate } from "../promote-proof";
import { installedPath, parseLockKey } from "../installed";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  allCanonicalItemRelPaths,
  itemRepoRelPath,
} from "../master";
import type { FragmentItemKind, ItemKind } from "../master";
import { NotFoundError, PreconditionError, ResultExitError } from "../errors";
import { pickUnavailableMessage } from "../pick";
import { runInteractivePromote } from "./promote-interactive";
import {
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitExistingPaths,
  headSha,
  isAncestor,
  lastTouchingContentCommit,
  objectTypeAtCommit,
  originRemoteUrl,
  resolveCommit,
  showAtCommit,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { PRODUCT_NAME } from "../identity";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { assertLocalScopeSupported } from "../local-config";
import {
  captureCommittedItemNeeds,
  readSidecarBytes,
  restoreSidecarBytes,
} from "../metadata";
import { replaceDirFromFiles } from "../sync";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import { printPrivateDotenvWarnings, privateDotenvFiles } from "../dotfiles";
import {
  allCanonicalFragmentRelPaths,
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  isFragmentKind,
  parseFragmentSourceText,
  touchedFragmentTargetsForItem,
} from "../fragments";
import { upstreamFactsForItem } from "../upstream-facts";
import {
  addToManifest,
  dataEntryV4OrThrow,
  refDisplay,
  type PromoteResult,
  type Scope,
} from "../promote-core";
import {
  installedSnapshot,
  namedFilesAtCommit,
  namedFilesFromInstalledSnapshot,
  shaOfNamedFiles,
  sidecarAtCommit,
  sidecarFromInstalledSnapshot,
} from "../item-snapshot";
import { mergeNamedTrees, namedFilesEqual } from "../merge-tree";
import { beginInstalledReconciliation } from "../promote-transaction";
import type { PromoteTransactionHooks } from "../promote-transaction";
import {
  CODEX_PROJECTION_ROOTS,
  commitDataRepoMutation,
} from "../marketplace-files";
import {
  hasCodexMarketplace,
  refreshCodexProjection,
  replaceSkillWithNamedFiles,
} from "../marketplace-integration";
import {
  lastTouchingSubagentCommit,
  subagentSourceCandidates,
  subagentSourcesAtCommit,
  validateSubagentSource,
} from "../subagents";
import {
  currentFragmentCandidateFiles,
  promotedSubagentFiles,
} from "../promote-candidate";
import { validatePromotePreview } from "../promote-preview";
import type { PromotePreviewGuard } from "../promote-preview";

export interface PromoteOptions {
  message?: string;
  json?: boolean;
  local?: boolean;
  staleOk?: boolean;
  merge?: boolean;
  /**
   * Not a CLI flag. The interactive loop promotes several items in one run
   * and prints the data-repo guidance once at the end instead of per item.
   */
  suppressGuidance?: boolean;
  /**
   * Not a CLI flag. The interactive loop pins the repository its catalog was
   * read from and promotes into that one — the same pin `runInteractiveAdd`
   * holds — so `capshelf data bind` in another terminal while the picker is
   * open cannot move the destination under the marks.
   */
  boundRepo?: string;
  /** The exact item base and candidate that the interactive overlay showed. */
  previewGuard?: PromotePreviewGuard;
  persistLock?: () => Promise<void>;
  afterMergePlan?: () => Promise<void>;
  beforeCanonicalWrite?: () => Promise<void>;
  transactionHooks?: PromoteTransactionHooks;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
  staleOk?: boolean;
  merge?: boolean;
  persistLock?: () => Promise<void>;
  afterMergePlan?: () => Promise<void>;
  snapshotHooks?: {
    afterSnapshotCaptured?: () => Promise<void>;
    beforeCanonicalCopy?: () => Promise<void>;
    afterCanonicalCopy?: () => Promise<void>;
  };
  transactionHooks?: PromoteTransactionHooks;
  previewGuard?: PromotePreviewGuard;
}

export function registerPromote(program: Command): void {
  program
    .command("promote [item]")
    .description(
      "push edits for an already-tracked data item into the data repo and bump the lock; with no item, pick from the promotable items interactively",
    )
    .option("--local", "promote a local-scope item")
    .option(
      "--stale-ok",
      "intentionally overwrite data-repo content newer than this project's lock",
    )
    .option(
      "--merge",
      "merge newer upstream content with this installed edit when clean",
    )
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .action(
      async (
        itemRef: string | undefined,
        opts: PromoteOptions,
        cmd: Command,
      ) => {
        if (itemRef === undefined) {
          await promoteWithoutItem(opts, cmd);
          return;
        }
        await promoteOne(itemRef, opts, cmd);
      },
    );
}

/** The no-item branch: the interactive picker over the tracked items. */
async function promoteWithoutItem(
  opts: PromoteOptions,
  cmd: Command,
): Promise<void> {
  // These flags are per-item judgments. `--stale-ok` authorizes overwriting
  // one item's newer upstream, and authorizing it for a pile of independent
  // marks would be consent to losses nobody enumerated.
  if (opts.staleOk || opts.merge) {
    throw new PreconditionError(
      "promote --stale-ok and --merge require an item",
    );
  }
  // `--json` names a scripted caller, and a script cannot answer a prompt.
  if (opts.json) {
    throw new PreconditionError(
      "promote --json requires an item; the interactive picker needs a terminal",
      {
        hint: "pass an item ref (capshelf promote <kind>/<name>), or run capshelf promote without --json to pick interactively",
      },
    );
  }
  const summary = await runInteractivePromote({ promote: opts, cmd });
  if (summary.outcome === "unavailable") {
    throw new PreconditionError(
      `cannot pick interactively — ${pickUnavailableMessage(summary.reason)}`,
      {
        hint: "name the item instead: capshelf promote <kind>/<name>. Run capshelf status to see what changed.",
      },
    );
  }
  // Any failed item is a refusal the user needs a non-zero code for; each one
  // already printed its reason and its retry command.
  if (summary.outcome === "promoted" && summary.failed.length > 0) {
    throw new ResultExitError(3);
  }
}

/**
 * One named promote, printing the same report whether the ref was typed or
 * marked in the picker. Returns the result so the interactive loop can tell a
 * commit from a no-op without re-parsing output.
 */
export async function promoteOne(
  itemRef: string,
  opts: PromoteOptions,
  cmd: Command,
): Promise<PromoteResult> {
  if (opts.merge && !opts.json) {
    console.error(
      `promote --merge is deprecated; use update ${itemRef} --merge, review the result, then run promote ${itemRef}`,
    );
  }
  if (opts.merge && opts.staleOk) {
    throw new PreconditionError(
      "--merge and --stale-ok cannot be combined; choose merge or overwrite",
    );
  }
  const ref = parseItemRef(itemRef);
  if (opts.local && ref.kind) {
    assertLocalScopeSupported(ref.kind, ref.name, "promote --local");
  }
  if (isSystemItemName(ref.name)) {
    throw new PreconditionError(
      `"${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
    );
  }

  const {
    project,
    manifest,
    projectLock: lock,
    localLock,
  } = await loadProjectContext({ cmd });
  const dataRepo =
    opts.boundRepo ?? (await resolveProjectDataRepo(project, manifest, cmd));

  let result: PromoteResult;
  let saveProject = false;
  let saveLocal = false;
  let lockPersisted = false;
  const writableLock = assertLockV4(lock, "capshelf promote");
  const writableLocalLock = assertLockV4(localLock, "capshelf promote");
  if (opts.local) {
    result = await promoteLocalTracked(
      project,
      dataRepo,
      writableLocalLock,
      ref,
      {
        ...opts,
        persistLock: async () => {
          await saveLocalLock(project, writableLocalLock);
          lockPersisted = true;
        },
      },
    );
    saveLocal = true;
  } else {
    result = await promoteProjectTracked(
      project,
      dataRepo,
      manifest,
      writableLock,
      writableLocalLock,
      ref,
      {
        ...opts,
        persistLock: async () => {
          await saveLock(project, writableLock);
          lockPersisted = true;
        },
      },
    );
    saveProject = true;
  }

  if (saveProject) {
    await saveManifest(project, manifest);
    if (!lockPersisted) await saveLock(project, writableLock);
  }
  if (saveLocal && !lockPersisted) {
    await saveLocalLock(project, writableLocalLock);
  }

  if (opts.json) {
    const origin = await originRemoteUrl(dataRepo);
    console.log(
      JSON.stringify(
        { ...result, dataRepo, dataRepoHasOrigin: origin !== null },
        null,
        2,
      ),
    );
    return result;
  }
  if (result.merged) {
    const action = result.committed
      ? "merged upstream and promoted"
      : "merged result already upstream for";
    console.log(
      `✓ ${action} data/${result.kind}/${result.name} @ ${result.sha}`,
    );
  } else {
    console.log(
      `✓ ${result.action} data/${result.kind}/${result.name} @ ${result.sha}`,
    );
  }
  console.log(`  source commit: ${result.sourceCommit}`);
  printRuntimeWarnings(result.runtimeWarnings);
  printPrivateDotenvWarnings(result.privateDotenvWarnings);
  if (result.committed && !opts.suppressGuidance) {
    await printShareUpstreamGuidance(dataRepo);
  }
  return result;
}

async function promoteProjectTracked(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  projectLock: LockV4,
  localLock: LockV4,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(projectLock, ref, "data");
  if (!key) {
    const localKey = lockKeyForRef(localLock, ref, "data");
    if (localKey) {
      const parsed = parseLockKey(localKey);
      const display = `${parsed.kind}/${parsed.name}`;
      throw new NotFoundError(
        `not tracked in project scope: ${display}\n` +
          `  found in local scope; run: capshelf promote ${display} --local`,
      );
    }
    return await rejectUntrackedPromote(project, projectLock, ref);
  }

  const parsed = parseLockKey(key);
  if (opts.merge && !supportsPromoteMerge(parsed.kind, "project")) {
    throw mergeUnsupportedError(parsed.kind, parsed.name);
  }
  if (isFragmentKind(parsed.kind)) {
    const result = await promoteFragmentSource(
      project,
      dataRepo,
      manifest,
      projectLock,
      parsed.kind,
      parsed.name,
      opts,
    );
    addToManifest(manifest, parsed.kind, parsed.name);
    return result;
  }
  if (isCopyTargetFileItemKind(parsed.kind)) {
    const result = await promoteSubagent(
      project,
      dataRepo,
      projectLock,
      parsed.name,
      opts,
    );
    addToManifest(manifest, parsed.kind, parsed.name);
    return result;
  }
  if (!isCopyDirectoryItemKind(parsed.kind)) {
    throw new Error(`no promote strategy for ${parsed.kind}/${parsed.name}`);
  }

  const result = await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    projectLock,
    opts,
  );
  addToManifest(manifest, parsed.kind, parsed.name);
  return result;
}

export async function promoteSubagent(
  project: string,
  dataRepo: string,
  lock: LockV4,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey("subagents", name);
  const entry = dataEntryV4OrThrow(lock.items[key], key);
  const lockedSources = await subagentSourcesAtCommit(
    project,
    dataRepo,
    name,
    entry.sourceCommit,
  );
  const pending: Array<{
    relPath: string;
    raw: Buffer;
  }> = [];
  for (const source of lockedSources) {
    const stat = lstatOrNull(source.outputPath);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      const state = stat ? "not a regular file" : "missing";
      throw new PreconditionError(
        `not promoting subagents/${name} — managed runtime target is ${state}: ${source.outputPath}\n` +
          `  restore locked outputs: capshelf revert subagents/${name}\n` +
          `  if upstream intentionally changed targets: capshelf update subagents/${name}`,
      );
    }
    const raw = await readFile(source.outputPath);
    const locked = await showAtCommit(
      dataRepo,
      entry.sourceCommit,
      source.relPath,
    );
    if (!raw.equals(locked)) {
      pending.push({
        relPath: source.relPath,
        raw,
      });
    }
  }
  const projectFiles = await promotedSubagentFiles(
    project,
    dataRepo,
    name,
    pending,
  );
  const previewHead = opts.previewGuard
    ? await validatePromotePreview({
        dataRepo,
        kind: "subagents",
        name,
        candidateFiles: projectFiles,
        guard: opts.previewGuard,
      })
    : undefined;
  if (pending.length === 0) {
    return {
      source: "data",
      kind: "subagents",
      name,
      action: "already-current",
      sha: entry.sourcePinDigest,
      sourceCommit: entry.sourceCommit,
      committed: false,
    };
  }

  const upstream = await upstreamFactsForItem(
    dataRepo,
    "subagents",
    name,
    "tree",
  );
  if (upstream.upstreamDirty) {
    throw new PreconditionError(
      `not promoting subagents/${name} — the data repo canonical sources have uncommitted changes`,
    );
  }
  const pendingByRelPath = new Map(
    pending.map(({ relPath, raw }) => [relPath, raw]),
  );
  const validationWarnings: string[] = [];
  for (const source of subagentSourceCandidates(project, name)) {
    const pendingRaw = pendingByRelPath.get(source.relPath);
    const sourcePath = join(dataRepo, ...source.relPath.split("/"));
    if (!pendingRaw && !existsSync(sourcePath)) continue;
    const raw = pendingRaw ?? (await readFile(sourcePath));
    validationWarnings.push(
      ...validateSubagentSource(source.target, name, raw.toString("utf-8"))
        .warnings,
    );
  }
  for (const warning of validationWarnings) console.error(`⚠ ${warning}`);
  const allAlreadyUpstream = (
    await Promise.all(
      pending.map(async ({ relPath, raw }) => {
        const path = join(dataRepo, ...relPath.split("/"));
        return existsSync(path) && raw.equals(await readFile(path));
      }),
    )
  ).every(Boolean);
  if (allAlreadyUpstream && upstream.upstreamSha !== null) {
    const sourceCommit = await lastTouchingSubagentCommit(
      project,
      dataRepo,
      name,
    );
    const snapshot = await captureCommittedItemNeeds(dataRepo, {
      kind: "subagents",
      name,
    });
    const pin = await pinItemAtCommit(
      dataRepo,
      "subagents",
      name,
      sourceCommit,
    );
    lock.items[key] = refreshDataLockEntry(entry, { pin, ...snapshot });
    return {
      source: "data",
      kind: "subagents",
      name,
      action: "already-upstream",
      sha: pin.sourcePinDigest,
      sourceCommit,
      pin,
      committed: false,
    };
  }

  let staleOverride = false;
  if (
    upstream.upstreamSha !== null &&
    upstream.upstreamSha !== entry.sourcePinDigest
  ) {
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind: "subagents",
        name,
        lockedSha: entry.sourcePinDigest,
        sourceCommit: entry.sourceCommit,
        upstreamSha: upstream.upstreamSha,
        logPathspecs: allCanonicalItemRelPaths("subagents", name),
        scope: "project",
      });
    }
    staleOverride = true;
  }
  const canonicalPaths = allCanonicalItemRelPaths("subagents", name);
  await assertRepoCleanOutsidePaths(dataRepo, canonicalPaths);
  await commitDataRepoMutation({
    dataRepo,
    expectedHead: previewHead ?? (await headSha(dataRepo)),
    ownedRoots: pending.map(({ relPath }) => relPath),
    message: opts.message ?? `capshelf: subagents/${name}`,
    mutate: async () => {
      await opts.beforeCanonicalWrite?.();
      for (const { relPath, raw } of pending) {
        const path = join(dataRepo, ...relPath.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await atomicWriteFile(path, raw);
      }
    },
    verify: async (commit) => {
      await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind: "subagents",
        name,
        commit,
        candidateFiles: projectFiles,
      });
    },
  });
  const sourceCommit = await lastTouchingSubagentCommit(
    project,
    dataRepo,
    name,
  );
  const pin = await pinItemAtCommit(dataRepo, "subagents", name, sourceCommit);
  const sha = pin.sourcePinDigest;
  const snapshot = await captureCommittedItemNeeds(dataRepo, {
    kind: "subagents",
    name,
  });
  lock.items[key] = refreshDataLockEntry(entry, { pin, ...snapshot });
  return {
    source: "data",
    kind: "subagents",
    name,
    action: "promoted",
    sha,
    sourceCommit,
    pin,
    committed: true,
    ...(staleOverride && { staleOverride: true as const }),
  };
}

async function promoteLocalTracked(
  project: string,
  dataRepo: string,
  localLock: LockV4,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(localLock, ref, "data");
  if (!key) {
    if (ref.kind === undefined || ref.kind === "skills") {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
        );
      }
    }
    throw new NotFoundError(`not tracked in local scope: ${refDisplay(ref)}`);
  }

  const parsed = parseLockKey(key);
  assertLocalScopeSupported(parsed.kind, parsed.name, "promote");
  if (opts.merge && !supportsPromoteMerge(parsed.kind, "local")) {
    throw mergeUnsupportedError(parsed.kind, parsed.name);
  }
  if (!isCopyDirectoryItemKind(parsed.kind)) {
    throw new PreconditionError(
      `promote --local requires a copy-directory item: ${parsed.kind}/${parsed.name}`,
    );
  }
  return await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    localLock,
    { ...opts, scope: "local" },
  );
}

async function rejectUntrackedPromote(
  project: string,
  lock: LockV4,
  ref: ReturnType<typeof parseItemRef>,
): Promise<never> {
  if (ref.kind === undefined || ref.kind === "skills") {
    const external = await findSkillsShSkill(project, ref.name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }
  const systemKey = lockKeyForRef(lock, ref, "system");
  if (systemKey) {
    throw new PreconditionError(
      `${ref.name} is a system item — submit a PR to the capshelf repo instead`,
    );
  }
  const display = refDisplay(ref);
  const adoptHint =
    ref.kind === undefined || ref.kind === "skills"
      ? `\n  to adopt a local-only skill into the data repo, run: capshelf share ${display} --to project`
      : "";
  throw new NotFoundError(
    `not tracked in this project: ${display}${adoptHint}`,
  );
}

export async function promoteFragmentSource(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: LockV4,
  kind: FragmentItemKind,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryV4OrThrow(lock.items[key], key);
  const canonicalPaths = allCanonicalFragmentRelPaths(kind, name);
  // Throws a PreconditionError when the data repo has no canonical source
  // files (the only expected empty case); letting it surface means genuine
  // git/fs failures propagate instead of being masked as "no source files."
  const existingSources = await currentFragmentSourcesForItem(
    dataRepo,
    kind,
    name,
  );

  await assertRepoCleanOutsidePaths(dataRepo, canonicalPaths);
  let dirty = false;
  const commitPaths: string[] = [];
  for (const relPath of canonicalPaths) {
    const pathDirty =
      (await statusPorcelain(dataRepo, relPath)).trim().length > 0;
    if (pathDirty || existsSync(join(dataRepo, ...relPath.split("/")))) {
      commitPaths.push(relPath);
    }
    dirty = dirty || pathDirty;
  }
  // The canonical sources as committed at HEAD, which is what both branches
  // below compare the lock against. Reading the commit rather than the
  // worktree is what makes the two comparable: `entry.sourcePinDigest` is a
  // digest over `(path, mode, blobId)` tree entries (`src/pin.ts:114`), and a
  // content hash of the same files is a different number.
  //
  // The clean branch used `shaOfFragmentItem(...) === entry.sha` until
  // 2026-08-26. `entry` is a `DataLockEntryV4`, whose `sha` is typed
  // `undefined` (`src/lock.ts:188-192`), so on a version 4 lock that test was
  // never true and every no-op fragment promote fell through to the refusal
  // below. The message named committed changes that did not exist and sent
  // the user to `capshelf update`, which had nothing to update.
  const headCommittedSha = sourcePinDigest(
    await itemTreeEntriesAtCommit(
      dataRepo,
      kind,
      name,
      await headSha(dataRepo),
    ),
  );
  if (!dirty) {
    // Nothing local to promote. The worktree is clean, so it holds what HEAD
    // holds, and the only question left is whether the lock names that.
    if (headCommittedSha === entry.sourcePinDigest) {
      return {
        source: "data",
        kind,
        name,
        action: "already-current",
        sha: entry.sourcePinDigest,
        sourceCommit: entry.sourceCommit,
        committed: false,
      };
    }
    // Not bypassable by --stale-ok: there is nothing local to promote, so the
    // only correct action is update.
    throw new PreconditionError(
      `${kind}/${name} has committed source changes not in this project lock; run capshelf update ${kind}/${name}`,
    );
  }

  // Stale gate for the dirty-commit path: the digest above ignores the dirty
  // worktree edits about to be committed. A difference means upstream
  // advanced past the lock, and committing would silently fold that advance
  // into a lock bump the user never reviewed.
  let staleOverride = false;
  if (headCommittedSha !== entry.sourcePinDigest) {
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sourcePinDigest,
        sourceCommit: entry.sourceCommit,
        upstreamSha: headCommittedSha,
        logPathspecs: canonicalPaths,
        scope: "project",
      });
    }
    staleOverride = true;
  }

  const candidateFiles = await currentFragmentCandidateFiles(
    dataRepo,
    kind,
    name,
  );
  const candidateByPath = new Map(
    candidateFiles.map((file) => [file.path, file.content]),
  );
  const itemRoot = itemRepoRelPath(kind, name);
  for (const source of existingSources) {
    const content = candidateByPath.get(
      posix.relative(itemRoot, source.relPath),
    );
    if (!content) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — canonical source changed while it was being read; retry`,
      );
    }
    parseFragmentSourceText(source, content.toString("utf-8"));
  }
  const previewHead = opts.previewGuard
    ? await validatePromotePreview({
        dataRepo,
        kind,
        name,
        candidateFiles,
        guard: opts.previewGuard,
      })
    : undefined;

  const oldLock = structuredClone(lock);
  // The canonical file is the user's own edit, sitting where they made it, so
  // a failure here restores the index and leaves the working tree alone
  // (GIT-7). Restoring the file would discard the edit being promoted.
  const sourceCommit = await commitExistingPaths({
    repo: dataRepo,
    relPaths: commitPaths,
    message: opts.message ?? `capshelf: ${kind}/${name}`,
    expectedHead: previewHead ?? (await headSha(dataRepo)),
    verify: async (commit) => {
      await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind,
        name,
        commit,
        candidateFiles,
      });
    },
  });
  // The verifier above binds the commit to the candidate snapshot. A hook or
  // concurrent editor can change the worktree after the preview and before
  // Git stages it. The transaction rolls back that commit and does not restore
  // or discard the worktree bytes.
  const pin = await pinItemAtCommit(dataRepo, kind, name, sourceCommit);
  const sha = pin.sourcePinDigest;
  const snapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
  const nextEntry = refreshDataLockEntry(entry, { pin, ...snapshot });
  lock.items[key] = nextEntry;

  for (const target of await touchedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
  )) {
    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock: lock,
      target,
    });
  }

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: true,
    ...(staleOverride && { staleOverride: true as const }),
  };
}

export async function syncTrackedIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  lock: LockV4,
  opts: SyncOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryV4OrThrow(lock.items[key], key);
  assertNotKeptLocal(entry, kind, name, opts.scope ?? "project");

  if (isFragmentKind(kind)) {
    throw new PreconditionError(
      `promote for ${kind}/${name} must use project-scope fragment source files`,
    );
  }
  if (isCopyTargetFileItemKind(kind)) {
    throw new PreconditionError(
      `promote is not implemented for copy-target-file item ${kind}/${name}`,
    );
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no promotion strategy for ${kind}/${name}`);
  }

  if (kind === "skills") {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const repoRelPath = itemRepoRelPath(kind, name);
  if (!existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo does not have ${repoRelPath}; run "capshelf share ${kind}/${name}" instead`,
    );
  }

  const snapshot = await installedSnapshot(
    project,
    kind,
    name,
    opts.scope ?? "project",
  );
  if (!snapshot) {
    throw new PreconditionError(
      `installed files are missing: ${installedPath(project, kind, name)}`,
    );
  }
  await opts.snapshotHooks?.afterSnapshotCaptured?.();
  const { localPath, sha } = snapshot;
  const requiredFile = kind === "skills" ? "SKILL.md" : "index.ts";
  const requiredFileStat = lstatOrNull(join(localPath, requiredFile));
  if (!requiredFileStat?.isFile()) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — required ${requiredFile} is missing or not a regular file`,
    );
  }
  if (!snapshot.files.includes(requiredFile)) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — required ${requiredFile} is not Git-visible in the installed snapshot`,
    );
  }
  for (const file of snapshot.files) {
    const fileStat = lstatOrNull(join(localPath, ...file.split("/")));
    if (!fileStat?.isFile()) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — installed snapshot path is not a regular file: ${file}`,
      );
    }
  }
  const localFiles = await namedFilesFromInstalledSnapshot(snapshot);
  if (shaOfNamedFiles(localFiles) !== sha) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — installed snapshot changed while it was being read; retry`,
    );
  }
  const previewHead = opts.previewGuard
    ? await validatePromotePreview({
        dataRepo,
        kind,
        name,
        candidateFiles: localFiles,
        guard: opts.previewGuard,
      })
    : undefined;
  const lockedCommit = await resolveCommit(dataRepo, entry.sourceCommit);
  if (lockedCommit === null && !opts.merge) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — the locked source commit is not available in the data repo`,
    );
  }
  const lockedFiles =
    lockedCommit === null
      ? null
      : await namedFilesAtCommit(dataRepo, repoRelPath, lockedCommit);
  const installedMatchesPin =
    lockedCommit !== null &&
    sourcePinDigest(
      namedFilesTreeEntries(
        localFiles,
        hashWidthOf(
          await itemTreeEntriesAtCommit(dataRepo, kind, name, lockedCommit),
        ),
      ),
    ) === entry.sourcePinDigest;
  if (
    lockedFiles !== null &&
    installedMatchesPin &&
    namedFilesEqual(localFiles, lockedFiles)
  ) {
    // Guard-free no-op by design: local content matches the lock, there is
    // nothing to write. If upstream has advanced past the lock here, that is
    // update_available territory and surfacing it is status's job.
    const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
    return {
      source: "data",
      kind,
      name,
      action: "already-current",
      sha: entry.sourcePinDigest,
      sourceCommit: entry.sourceCommit,
      committed: false,
      ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    };
  }

  // Stale guard: protects data-repo writes. Runs before anything is written
  // or committed, covering both the dirty-commit path and the
  // not-dirty-but-changed repin path below. Shares the upstream-facts
  // computation with status so the state machine and this gate can never
  // disagree.
  const upstream = await upstreamFactsForItem(dataRepo, kind, name, "tree");
  if (upstream.upstreamDirty) {
    // Not bypassable by --stale-ok: uncommitted upstream edits have no
    // commit provenance; promoting over them would either destroy them or
    // fold unknown content into the promote commit.
    throw new PreconditionError(
      `not promoting ${kind}/${name} — the data repo copy has uncommitted changes.\n\n` +
        "  inspect them first:\n" +
        `    git -C ${homeRelative(dataRepo)} status --short -- ${repoRelPath}\n` +
        "  then commit or discard them in the data repo and retry.",
    );
  }
  let staleOverride = false;
  const upstreamSha = upstream.upstreamSha;
  const upstreamChanged =
    upstreamSha !== null &&
    (upstreamSha !== entry.sourcePinDigest ||
      (upstream.sourceCommit !== null &&
        upstream.sourceCommit !== entry.sourceCommit));
  if (upstreamChanged) {
    const upstreamFiles = await namedFilesAtCommit(
      dataRepo,
      repoRelPath,
      upstream.sourceCommit ?? "HEAD",
    );
    if (namedFilesEqual(localFiles, upstreamFiles)) {
      // Convergence short-circuit: the project's edited content is
      // byte-identical to what upstream already has (e.g. a teammate
      // promoted the same fix first). Metadata-only lock repin; commit
      // nothing, touch nothing in the data repo.
      const sourceCommit = await lastTouchingContentCommit(
        dataRepo,
        repoRelPath,
      );
      const needsSnapshot = await captureCommittedItemNeeds(dataRepo, {
        kind,
        name,
      });
      // Convergence, so the commit already holds the project's bytes — proving
      // `A == B` here is the same check, and it is cheap.
      const pin = await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind,
        name,
        commit: sourceCommit,
        candidateFiles: localFiles,
      });
      lock.items[key] = refreshDataLockEntry(entry, { pin, ...needsSnapshot });
      const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
      return {
        source: "data",
        kind,
        name,
        action: "already-upstream",
        sha: pin.sourcePinDigest,
        sourceCommit,
        pin,
        committed: false,
        ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
      };
    }
    if (opts.merge) {
      return await mergeStalePromote({
        project,
        dataRepo,
        kind,
        name,
        lock,
        key,
        entry,
        snapshot,
        upstreamSha,
        opts,
      });
    }
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sourcePinDigest,
        sourceCommit: entry.sourceCommit,
        upstreamSha,
        logPathspecs: [repoRelPath],
        scope: opts.scope ?? "project",
      });
    }
    staleOverride = true;
  }

  await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  // The directory replace removes the data-repo .capshelf.yml wholesale, but
  // projects never receive the sidecar: cache it and restore it afterwards
  // unless the project copy supplied its own (the project's wins).
  const dataDir = join(dataRepo, repoRelPath);
  const upstreamSidecar = await readSidecarBytes(dataDir);
  const codexConfigured = kind === "skills" && hasCodexMarketplace(dataRepo);
  const replaceSource = async (): Promise<void> => {
    await opts.snapshotHooks?.beforeCanonicalCopy?.();
    await replaceDirFromFiles(localPath, snapshot.files, dataDir);
    await restoreSidecarBytes(dataDir, upstreamSidecar);
    await opts.snapshotHooks?.afterCanonicalCopy?.();
    const currentSnapshot = await installedSnapshot(
      project,
      kind,
      name,
      opts.scope ?? "project",
    );
    const currentFiles =
      currentSnapshot === null
        ? null
        : await namedFilesFromInstalledSnapshot(currentSnapshot);
    if (
      currentSnapshot === null ||
      currentFiles === null ||
      !namedFilesEqual(localFiles, currentFiles)
    ) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — installed snapshot changed during promotion; retry`,
      );
    }
    if (kind === "skills") await refreshCodexProjection(dataRepo);
  };
  const expectedHead = previewHead ?? (await headSha(dataRepo));
  // PIN-11. The old guard compared one working-tree hash of the data repo
  // against another, both taken *after* the copy — so a `pre-commit` hook, a
  // clean filter, or a nested `.gitattributes` that rewrote the content
  // between the copy and the commit passed it, and capshelf published bytes
  // the project never held. This compares the project snapshot (`A`) with the
  // tree the commit actually produced (`B`), inside the transaction, so a
  // refusal unwinds the commit and the worktree.
  let pin: PinnedSource | undefined;
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead,
    ownedRoots: codexConfigured
      ? [repoRelPath, ...CODEX_PROJECTION_ROOTS]
      : [repoRelPath],
    message: opts.message ?? `capshelf: ${kind}/${name}`,
    mutate: replaceSource,
    verify: async (commit) => {
      pin = await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind,
        name,
        commit,
        candidateFiles: localFiles,
      });
    },
  });
  if (!pin) throw new Error(`expected a verified pin for ${kind}/${name}`);

  const needsSnapshot = await captureCommittedItemNeeds(dataRepo, {
    kind,
    name,
  });
  lock.items[key] = refreshDataLockEntry(entry, { pin, ...needsSnapshot });
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha: pin.sourcePinDigest,
    sourceCommit,
    pin,
    committed: true,
    ...(staleOverride && { staleOverride: true as const }),
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

async function mergeStalePromote(input: {
  project: string;
  dataRepo: string;
  kind: "skills" | "pi-extensions";
  name: string;
  lock: LockV4;
  key: string;
  entry: DataLockEntryV4;
  snapshot: NonNullable<Awaited<ReturnType<typeof installedSnapshot>>>;
  upstreamSha: string;
  opts: SyncOptions;
}): Promise<PromoteResult> {
  const {
    project,
    dataRepo,
    kind,
    name,
    lock,
    key,
    entry,
    snapshot,
    upstreamSha,
    opts,
  } = input;
  const scope = opts.scope ?? "project";
  if (!supportsPromoteMerge(kind, scope)) {
    throw mergeUnsupportedError(kind, name);
  }

  const repoRelPath = itemRepoRelPath(kind, name);
  await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
  const plannedHead = await headSha(dataRepo);
  const mergeBase = await resolveCommit(dataRepo, entry.sourceCommit);
  if (mergeBase === null) {
    throw mergeProvenanceError(
      kind,
      name,
      "the locked source commit is not available in the data repo",
      scope,
    );
  }
  if (!(await isAncestor(dataRepo, mergeBase, plannedHead))) {
    throw mergeProvenanceError(
      kind,
      name,
      "the locked source commit is not an ancestor of data-repo HEAD",
      scope,
    );
  }
  if ((await objectTypeAtCommit(dataRepo, mergeBase, repoRelPath)) !== "tree") {
    throw mergeProvenanceError(
      kind,
      name,
      "the locked source commit does not contain the item directory",
      scope,
    );
  }

  const [baseFiles, localFiles, upstreamFiles, localSidecar, upstreamSidecar] =
    await Promise.all([
      namedFilesAtCommit(dataRepo, repoRelPath, mergeBase),
      namedFilesFromInstalledSnapshot(snapshot),
      namedFilesAtCommit(dataRepo, repoRelPath, plannedHead),
      sidecarFromInstalledSnapshot(snapshot),
      sidecarAtCommit(dataRepo, repoRelPath, plannedHead),
    ]);
  const baseEntries = await itemTreeEntriesAtCommit(
    dataRepo,
    kind,
    name,
    mergeBase,
  );
  if (sourcePinDigest(baseEntries) !== entry.sourcePinDigest) {
    throw mergeProvenanceError(
      kind,
      name,
      "the locked source commit does not reproduce the locked item content",
      scope,
    );
  }

  const merged = await mergeNamedTrees(baseFiles, localFiles, upstreamFiles);
  if (!merged.ok) {
    const scopeFlag = scope === "local" ? " --local" : "";
    const localWarning =
      scope === "local"
        ? "  local-scope files are excluded from project Git; copy the edit somewhere safe first.\n\n"
        : "";
    throw new PreconditionError(
      `automatic merge conflicts in ${kind}/${name}; nothing changed.\n\n` +
        `  conflicting paths:\n${merged.conflicts.map((path) => `    ${path}`).join("\n")}\n\n` +
        "  preserve your edit before taking upstream, then reapply it:\n" +
        localWarning +
        `    capshelf update ${kind}/${name}${scopeFlag}\n\n` +
        "  to replace upstream on purpose:\n" +
        `    capshelf promote ${kind}/${name}${scopeFlag} --stale-ok -m "..."`,
    );
  }
  await opts.afterMergePlan?.();

  const revalidateInputs = async (): Promise<void> => {
    const revalidated = await installedSnapshot(project, kind, name, scope);
    if (revalidated === null) {
      throw new PreconditionError(
        `installed files changed while preparing the merge: ${installedPath(project, kind, name)}`,
      );
    }
    const [revalidatedFiles, revalidatedSidecar] = await Promise.all([
      namedFilesFromInstalledSnapshot(revalidated),
      sidecarFromInstalledSnapshot(revalidated),
    ]);
    const latestUpstream = await upstreamFactsForItem(
      dataRepo,
      kind,
      name,
      "tree",
    );
    await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
    if (
      (await headSha(dataRepo)) !== plannedHead ||
      latestUpstream.upstreamDirty ||
      latestUpstream.upstreamSha !== upstreamSha ||
      !namedFilesEqual(localFiles, revalidatedFiles) ||
      !buffersEqual(localSidecar, revalidatedSidecar)
    ) {
      throw new PreconditionError(
        `${kind}/${name} changed while preparing the merge; nothing was committed. Retry promote --merge.`,
      );
    }
  };
  await revalidateInputs();

  const mergedFiles = merged.files;
  const mergedSidecar = localSidecar ?? upstreamSidecar;
  const noDataCommit =
    namedFilesEqual(mergedFiles, upstreamFiles) &&
    buffersEqual(mergedSidecar, upstreamSidecar);

  let sourceCommit: string;
  let pin: PinnedSource;
  let needsSnapshot: Awaited<ReturnType<typeof captureCommittedItemNeeds>>;
  if (noDataCommit) {
    sourceCommit = await lastTouchingContentCommit(dataRepo, repoRelPath);
    needsSnapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
    await revalidateInputs();
    const installedTransaction = await beginInstalledReconciliation(
      snapshot.localPath,
      localFiles,
      mergedFiles,
    );
    // PIN-11 for a merge candidate: `A` is the merge result, not the project
    // tree, and the commit it converged on must hold exactly those bytes.
    pin = await assertCommittedTreeEqualsCandidate({
      dataRepo,
      kind,
      name,
      commit: sourceCommit,
      candidateFiles: mergedFiles,
    });
    const previous = lock.items[key];
    lock.items[key] = refreshDataLockEntry(entry, { pin, ...needsSnapshot });
    try {
      await opts.persistLock?.();
      await installedTransaction.commit();
    } catch (error) {
      if (previous === undefined) {
        delete lock.items[key];
      } else {
        lock.items[key] = previous;
      }
      await installedTransaction.rollback();
      throw error;
    }
  } else {
    // GIT-9. One commit mechanism, whatever else the data repo is configured
    // for: a Codex marketplace decides which files the commit owns, and
    // nothing else. The merge used to commit through `commit-tree` when no
    // marketplace was configured, which runs none of the repository's hooks —
    // the same command trusted the user's `pre-commit` in one repository and
    // bypassed it in another, selected by a setting about plugins.
    const codexConfigured = kind === "skills" && hasCodexMarketplace(dataRepo);
    await commitDataRepoMutation({
      dataRepo,
      expectedHead: plannedHead,
      ownedRoots: codexConfigured
        ? [repoRelPath, ...CODEX_PROJECTION_ROOTS]
        : [repoRelPath],
      message: opts.message ?? `capshelf: ${kind}/${name}`,
      mutate: async () => {
        await revalidateInputs();
        await opts.transactionHooks?.afterPrepared?.();
        await replaceSkillWithNamedFiles(
          dataRepo,
          repoRelPath,
          mergedFiles,
          mergedSidecar,
        );
        if (codexConfigured) await refreshCodexProjection(dataRepo);
        await opts.transactionHooks?.afterPathReplaced?.();
        await opts.transactionHooks?.beforeHeadAdvance?.();
      },
      // PIN-11 for a merge candidate: `A` is the merge result, and the commit
      // must hold exactly those bytes. Inside the transaction, so a hook that
      // rewrites a merged file unwinds the commit instead of leaving the data
      // repo a commit ahead of a lock this project never recorded.
      verify: async (commit) => {
        await assertCommittedTreeEqualsCandidate({
          dataRepo,
          kind,
          name,
          commit,
          candidateFiles: mergedFiles,
        });
      },
    });
    const installedTransaction = await beginInstalledReconciliation(
      snapshot.localPath,
      localFiles,
      mergedFiles,
    );
    await installedTransaction.commit();
    // The pin is recorded against the last commit touching item *content*, so
    // a sidecar-only merge does not move it. `verify` already proved the tree,
    // and no commit since has changed it.
    sourceCommit = await lastTouchingContentCommit(dataRepo, repoRelPath);
    needsSnapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
    pin = await pinItemAtCommit(dataRepo, kind, name, sourceCommit);
    lock.items[key] = refreshDataLockEntry(entry, { pin, ...needsSnapshot });
  }

  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
  const privateDotenvWarnings = privateDotenvFiles(
    mergedFiles.map((file) => file.path),
  );
  return {
    source: "data",
    kind,
    name,
    action: noDataCommit ? "already-upstream" : "promoted",
    sha: pin.sourcePinDigest,
    sourceCommit,
    pin,
    committed: !noDataCommit,
    merged: true,
    mergeBase,
    mergedUpstreamCommit: plannedHead,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

/**
 * The keep-local marker asserts that this project's divergence is intentional
 * and should not be reconciled. Promoting publishes that divergence upstream,
 * which ends it — so the marker and the promote contradict each other and the
 * user has to say which one they meant.
 */
function assertNotKeptLocal(
  entry: DataLockEntryV4,
  kind: ItemKind,
  name: string,
  scope: Scope,
): void {
  if (entry.local !== true) return;
  const item = `${kind}/${name}`;
  const scopeFlag = scope === "local" ? " --local" : "";
  throw new PreconditionError(
    `not promoting ${item} — marked as intentional project-local divergence\n` +
      (entry.localReason ? `    reason: ${entry.localReason}\n` : "") +
      "  promoting publishes this divergence upstream, which ends it. Clear the marker first:\n" +
      `    ${PRODUCT_NAME} keep-local ${item}${scopeFlag} --unset\n` +
      `    ${PRODUCT_NAME} promote ${item}${scopeFlag} -m "<message>"\n` +
      "  between those two commands the item is drifted and unmanaged — do not run\n" +
      `  ${PRODUCT_NAME} apply until the promote completes`,
  );
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}

/**
 * Whether `promote --merge` can run for this item. A three-way merge needs a
 * copy-directory tree, and Pi extensions merge in project scope only
 * (docs/cli.md:986-988). Every `--merge` gate and the stale refusal read this
 * one answer, so the refusal never offers a command that then refuses.
 */
function supportsPromoteMerge(kind: ItemKind, scope: Scope): boolean {
  if (!isCopyDirectoryItemKind(kind)) return false;
  return !(kind === "pi-extensions" && scope === "local");
}

function mergeUnsupportedError(
  kind: ItemKind,
  name: string,
): PreconditionError {
  if (isFragmentKind(kind)) {
    return new PreconditionError(
      `promote --merge requires a copy-directory item; ${kind}/${name} is a fragment`,
    );
  }
  if (isCopyTargetFileItemKind(kind)) {
    return new PreconditionError(
      `promote --merge is not supported for ${kind}/${name}; copy-target-file items support --stale-ok only`,
    );
  }
  // The one remaining case: a copy-directory kind that this scope excludes.
  return new PreconditionError(
    `promote --merge for ${kind} is supported only in project scope`,
  );
}

function mergeProvenanceError(
  kind: ItemKind,
  name: string,
  reason: string,
  scope: Scope,
): PreconditionError {
  const scopeFlag = scope === "local" ? " --local" : "";
  return new PreconditionError(
    `cannot safely merge ${kind}/${name}: ${reason}.\n` +
      "  restore the locked data-repo history, or preserve your edits and refresh the item:\n" +
      `    capshelf update ${kind}/${name}${scopeFlag}`,
  );
}

function stalePromoteError(input: {
  dataRepo: string;
  kind: ItemKind;
  name: string;
  lockedSha: string;
  sourceCommit: string;
  upstreamSha: string;
  logPathspecs: string[];
  scope: Scope;
}): PreconditionError {
  const item = `${input.kind}/${input.name}`;
  // The item ref appears bare in prose and quoted in every command line. An
  // item name comes from the lock or the data-repo catalog, which a cloned
  // project treats as untrusted, and `isSafeItemName` permits a space and a
  // `$` — so an unquoted printed command would carry that text into the
  // user's shell. `shellArg` leaves ordinary refs unchanged.
  const itemArg = shellArg(item);
  const shortCommit = input.sourceCommit.slice(0, 7);
  const scopeFlag = input.scope === "local" ? " --local" : "";
  const preserveHint =
    input.scope === "local"
      ? "  (preserve your current edits first; local-scope files are excluded from this project's Git):\n"
      : "  (preserve your current edits first; update replaces the installed copy):\n";
  // The merge choice is the only one that keeps both sides, so it comes first
  // — but only where it can run. Offering it for a fragment, a subagent, or a
  // local Pi extension would print a command that then refuses.
  const mergeChoice = isCopyDirectoryItemKind(input.kind)
    ? "  inspect both lines of work:\n" +
      `    capshelf status ${itemArg}${scopeFlag} --diff\n\n` +
      "  merge upstream into this installed copy:\n" +
      `    capshelf update ${itemArg}${scopeFlag} --merge\n\n` +
      "  review the merged installed copy:\n" +
      `    capshelf status ${itemArg}${scopeFlag} --diff-view installed\n\n` +
      "  publish after review:\n" +
      `    capshelf promote ${itemArg}${scopeFlag} -m "..."\n\n`
    : "";
  return new PreconditionError(
    `${item} changed in the data repo since this project last updated; promoting would overwrite the newer upstream version.\n\n` +
      `  locked:   ${input.lockedSha}  (sourceCommit ${shortCommit})\n` +
      `  upstream: ${input.upstreamSha}  (data repo HEAD)\n\n` +
      "  optional history context:\n" +
      // The absolute repo path and a quoted pathspec: this line is a command
      // to paste, and `~` is not data a quoted argument can expand.
      `    git -C ${shellArg(input.dataRepo)} log --oneline ${shortCommit}..HEAD -- ${input.logPathspecs
        .map(shellArg)
        .join(" ")}\n\n` +
      mergeChoice +
      "  to take the upstream version and redo your edit on top of it\n" +
      preserveHint +
      `    capshelf update ${itemArg}${scopeFlag}\n\n` +
      "  to overwrite upstream with this installed version on purpose:\n" +
      `    capshelf promote ${itemArg}${scopeFlag} --stale-ok -m "..."`,
  );
}
