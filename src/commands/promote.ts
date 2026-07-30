import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { homeRelative } from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  dataKey,
  refreshDataLockEntry,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { Lock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  itemRepoRelPath,
} from "../master";
import type { FragmentItemKind, ItemKind } from "../master";
import { NotFoundError, PreconditionError } from "../errors";
import {
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitInRepo,
  headSha,
  isAncestor,
  lastTouchingContentCommit,
  objectTypeAtCommit,
  originRemoteUrl,
  resolveCommit,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { assertLocalScopeSupported } from "../local-config";
import {
  captureCommittedItemNeeds,
  readSidecarBytes,
  restoreSidecarBytes,
} from "../metadata";
import { replaceDirFromFiles, replaceDirFromGitVisibleFiles } from "../sync";
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
  shaOfFragmentItem,
  shaOfFragmentItemAtCommit,
  touchedFragmentTargetsForItem,
} from "../fragments";
import { upstreamFactsForItem } from "../upstream-facts";
import {
  addToManifest,
  dataEntryOrThrow,
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
import {
  beginInstalledReconciliation,
  commitNamedFilesTransaction,
} from "../promote-transaction";
import type { PromoteTransactionHooks } from "../promote-transaction";

interface PromoteOptions {
  message?: string;
  json?: boolean;
  local?: boolean;
  staleOk?: boolean;
  merge?: boolean;
  persistLock?: () => Promise<void>;
  afterMergePlan?: () => Promise<void>;
  transactionHooks?: PromoteTransactionHooks;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
  staleOk?: boolean;
  merge?: boolean;
  persistLock?: () => Promise<void>;
  afterMergePlan?: () => Promise<void>;
  transactionHooks?: PromoteTransactionHooks;
}

export function registerPromote(program: Command): void {
  program
    .command("promote <item>")
    .description(
      "push edits for an already-tracked data item into the data repo and bump the lock",
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
    .action(async (itemRef: string, opts: PromoteOptions, cmd: Command) => {
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
      const dataRepo = await resolveProjectDataRepo(project, manifest, cmd);

      let result: PromoteResult;
      let saveProject = false;
      let saveLocal = false;
      let lockPersisted = false;
      if (opts.local) {
        result = await promoteLocalTracked(project, dataRepo, localLock, ref, {
          ...opts,
          persistLock: async () => {
            await saveLocalLock(project, localLock);
            lockPersisted = true;
          },
        });
        saveLocal = true;
      } else {
        result = await promoteProjectTracked(
          project,
          dataRepo,
          manifest,
          lock,
          localLock,
          ref,
          {
            ...opts,
            persistLock: async () => {
              await saveLock(project, lock);
              lockPersisted = true;
            },
          },
        );
        saveProject = true;
      }

      if (saveProject) {
        await saveManifest(project, manifest);
        if (!lockPersisted) await saveLock(project, lock);
      }
      if (saveLocal && !lockPersisted) {
        await saveLocalLock(project, localLock);
      }

      const origin = await originRemoteUrl(dataRepo);
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ...result, dataRepo, dataRepoHasOrigin: origin !== null },
            null,
            2,
          ),
        );
        return;
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
      if (result.committed) {
        console.log("");
        console.log("committed to local data repo:");
        console.log(`  ${homeRelative(dataRepo)}`);
        if (origin !== null) {
          console.log("");
          console.log("to share upstream:");
          console.log(`  cd ${homeRelative(dataRepo)}`);
          console.log("  git push");
        }
      }
    });
}

async function promoteProjectTracked(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  projectLock: Lock,
  localLock: Lock,
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
  if (isFragmentKind(parsed.kind)) {
    if (opts.merge) {
      throw new PreconditionError(
        `promote --merge requires a copy-directory item; ${parsed.kind}/${parsed.name} is a fragment`,
      );
    }
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
    throw new PreconditionError(
      `promote is not implemented for copy-target-file item ${parsed.kind}/${parsed.name}`,
    );
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

async function promoteLocalTracked(
  project: string,
  dataRepo: string,
  localLock: Lock,
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
  if (opts.merge && parsed.kind === "pi-extensions") {
    throw new PreconditionError(
      "promote --merge for pi-extensions is supported only in project scope",
    );
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
  lock: Lock,
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
  lock: Lock,
  kind: FragmentItemKind,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);
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
  const currentSha = await shaOfFragmentItem(dataRepo, kind, name);
  if (!dirty) {
    if (currentSha === entry.sha) {
      return {
        source: "data",
        kind,
        name,
        action: "already-current",
        sha: currentSha,
        sourceCommit: entry.sourceCommit,
        committed: false,
      };
    }
    // Unchanged and not bypassable by --stale-ok: in this branch there is
    // nothing local to promote, the only correct action is update.
    throw new PreconditionError(
      `${kind}/${name} has committed source changes not in this project lock; run capshelf update ${kind}/${name}`,
    );
  }

  // Stale gate for the dirty-commit path: compare the canonical sources as
  // committed at HEAD (ignoring the dirty worktree edits about to be
  // committed) against the lock. A difference means upstream advanced past
  // the lock; committing would silently fold that advance into a lock bump
  // the user never reviewed.
  const headCommittedSha = await shaOfFragmentItemAtCommit(
    dataRepo,
    kind,
    name,
    "HEAD",
  );
  let staleOverride = false;
  if (headCommittedSha !== entry.sha) {
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sha,
        sourceCommit: entry.sourceCommit,
        upstreamSha: headCommittedSha,
        logPathspec: canonicalPaths.join(" "),
        scope: "project",
      });
    }
    staleOverride = true;
  }

  for (const source of existingSources) {
    parseFragmentSourceText(
      source,
      await readFile(join(dataRepo, ...source.relPath.split("/")), "utf-8"),
    );
  }

  const oldLock = structuredClone(lock);
  const sourceCommit = await commitInRepo(
    dataRepo,
    commitPaths,
    opts.message ?? `capshelf: ${kind}/${name}`,
  );
  const sha = await shaOfFragmentItem(dataRepo, kind, name);
  const snapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
  const nextEntry = refreshDataLockEntry(entry, {
    sha,
    sourceCommit,
    ...snapshot,
  });
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
  lock: Lock,
  opts: SyncOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);

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
  const { localPath, sha } = snapshot;
  if (sha === entry.sha) {
    // Guard-free no-op by design: local content matches the lock, there is
    // nothing to write. If upstream has advanced past the lock here, that is
    // update_available territory and surfacing it is status's job.
    const runtimeWarnings = runtimeWarningsForItem(project, kind, name, {
      needs: entry.needs ?? undefined,
    });
    return {
      source: "data",
      kind,
      name,
      action: "already-current",
      sha,
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
  const upstream = await upstreamFactsForItem(dataRepo, kind, name);
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
  if (upstream.upstreamSha !== null && upstream.upstreamSha !== entry.sha) {
    if (upstream.upstreamSha === sha) {
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
      lock.items[key] = refreshDataLockEntry(entry, {
        sha,
        sourceCommit,
        ...needsSnapshot,
      });
      const runtimeWarnings = runtimeWarningsForItem(project, kind, name, {
        needs: needsSnapshot.needs,
      });
      return {
        source: "data",
        kind,
        name,
        action: "already-upstream",
        sha,
        sourceCommit,
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
        upstreamSha: upstream.upstreamSha,
        opts,
      });
    }
    if (!opts.staleOk) {
      throw stalePromoteError({
        dataRepo,
        kind,
        name,
        lockedSha: entry.sha,
        sourceCommit: entry.sourceCommit,
        upstreamSha: upstream.upstreamSha,
        logPathspec: repoRelPath,
        scope: opts.scope ?? "project",
      });
    }
    staleOverride = true;
  }

  await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
  const localRelPath = relative(project, localPath);
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  // The directory replace removes the data-repo .capshelf.yml wholesale, but
  // projects never receive the sidecar: cache it and restore it afterwards
  // unless the project copy supplied its own (the project's wins).
  const dataDir = join(dataRepo, repoRelPath);
  const upstreamSidecar = await readSidecarBytes(dataDir);
  if (snapshot.source === "filesystem") {
    await replaceDirFromFiles(localPath, snapshot.files, dataDir);
  } else {
    await replaceDirFromGitVisibleFiles(
      project,
      localRelPath,
      localPath,
      dataDir,
    );
  }
  await restoreSidecarBytes(dataDir, upstreamSidecar);

  const dirty =
    (await statusPorcelain(dataRepo, repoRelPath)).trim().length > 0;
  const sourceCommit = dirty
    ? await commitInRepo(
        dataRepo,
        [repoRelPath],
        opts.message ?? `capshelf: ${kind}/${name}`,
      )
    : // The not-dirty re-pin must stay sidecar-blind: re-pinning after a
      // metadata-only upstream commit keeps the old sourceCommit. The dirty
      // branch usually commits content, but with a stale lock sha plus a
      // sidecar-only difference the promote commit can be sidecar-only; the
      // recorded sourceCommit then names that commit, which is harmless —
      // `git show` at it still yields the locked content.
      await lastTouchingContentCommit(dataRepo, repoRelPath);

  const needsSnapshot = await captureCommittedItemNeeds(dataRepo, {
    kind,
    name,
  });
  lock.items[key] = refreshDataLockEntry(entry, {
    sha,
    sourceCommit,
    ...needsSnapshot,
  });
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name, {
    needs: needsSnapshot.needs,
  });

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: dirty,
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
  lock: Lock;
  key: string;
  entry: ReturnType<typeof dataEntryOrThrow>;
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
  if (kind === "pi-extensions" && scope === "local") {
    throw new PreconditionError(
      "promote --merge for pi-extensions is supported only in project scope",
    );
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
  if (shaOfNamedFiles(baseFiles) !== entry.sha) {
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
    const latestUpstream = await upstreamFactsForItem(dataRepo, kind, name);
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
  const mergedSha = shaOfNamedFiles(mergedFiles);
  const mergedSidecar = localSidecar ?? upstreamSidecar;
  const noDataCommit =
    namedFilesEqual(mergedFiles, upstreamFiles) &&
    buffersEqual(mergedSidecar, upstreamSidecar);

  let sourceCommit: string;
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
    const previous = lock.items[key];
    lock.items[key] = refreshDataLockEntry(entry, {
      sha: mergedSha,
      sourceCommit,
      ...needsSnapshot,
    });
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
    await commitNamedFilesTransaction({
      repo: dataRepo,
      repoRelPath,
      files: mergedFiles,
      sidecar: mergedSidecar,
      expectedHead: plannedHead,
      message: opts.message ?? `capshelf: ${kind}/${name}`,
      beforePersistentMutation: revalidateInputs,
      hooks: opts.transactionHooks,
    });
    const installedTransaction = await beginInstalledReconciliation(
      snapshot.localPath,
      localFiles,
      mergedFiles,
    );
    await installedTransaction.commit();
    sourceCommit = await lastTouchingContentCommit(dataRepo, repoRelPath);
    needsSnapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
    lock.items[key] = refreshDataLockEntry(entry, {
      sha: mergedSha,
      sourceCommit,
      ...needsSnapshot,
    });
  }

  const runtimeWarnings = runtimeWarningsForItem(project, kind, name, {
    needs: needsSnapshot.needs,
  });
  const privateDotenvWarnings = privateDotenvFiles(
    mergedFiles.map((file) => file.path),
  );
  return {
    source: "data",
    kind,
    name,
    action: noDataCommit ? "already-upstream" : "promoted",
    sha: mergedSha,
    sourceCommit,
    committed: !noDataCommit,
    merged: true,
    mergeBase,
    mergedUpstreamCommit: plannedHead,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
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
  logPathspec: string;
  scope: Scope;
}): PreconditionError {
  const item = `${input.kind}/${input.name}`;
  const shortCommit = input.sourceCommit.slice(0, 7);
  const repo = homeRelative(input.dataRepo);
  const scopeFlag = input.scope === "local" ? " --local" : "";
  const preserveHint =
    input.scope === "local"
      ? "  (preserve your current edits first; local-scope files are excluded from this project's Git):\n"
      : "  (preserve your current edits first; update replaces the installed copy):\n";
  return new PreconditionError(
    `${item} changed in the data repo since this project last updated; promoting would overwrite the newer upstream version.\n\n` +
      `  locked:   ${input.lockedSha}  (sourceCommit ${shortCommit})\n` +
      `  upstream: ${input.upstreamSha}  (data repo HEAD)\n\n` +
      "  inspect before deciding:\n" +
      `    capshelf status ${item} --diff${scopeFlag}\n` +
      `    git -C ${repo} log --oneline ${shortCommit}..HEAD -- ${input.logPathspec}\n\n` +
      "  to take the upstream version and redo your edit on top of it\n" +
      preserveHint +
      `    capshelf update ${item}${scopeFlag}\n\n` +
      "  to overwrite upstream with this installed version on purpose:\n" +
      `    capshelf promote ${item}${scopeFlag} --stale-ok -m "..."`,
  );
}
