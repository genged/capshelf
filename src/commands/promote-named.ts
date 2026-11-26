import type { Command } from "commander";
import { printShareUpstreamGuidance } from "./share-named";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { atomicWriteFile, ensureDir, lstatOrNull } from "../fs-utils";
import { dataRepoScope } from "../path-safety";
import { homeRelative, shellArg } from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  assertWritableLock,
  dataKey,
  refreshDataLockEntry,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntryV4, WritableLock } from "../lock";
import {
  hashWidthOf,
  itemTreeEntriesAtCommit,
  namedFilesTreeEntries,
  pinItemAtCommit,
  sourcePinDigest,
} from "../pin";
import type { PinnedSource } from "../pin";
import { assertCommittedTreeEqualsCandidate } from "../promote-proof";
import { gitTreeSource } from "../item-source";
import { installedPath, parseLockKey } from "../installed";
import {
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  allCanonicalItemRelPaths,
  itemRepoRelPath,
  readPluginManifestName,
  PLUGIN_MANIFEST_REL,
} from "../master";
import type { FragmentItemKind, ItemKind } from "../master";
import { NotFoundError, PreconditionError } from "../errors";
import {
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitExistingPaths,
  headSha,
  lastTouchingContentCommit,
  originRemoteUrl,
  projectIgnoreRule,
  resolveCommit,
  showAtCommit,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { PRODUCT_NAME } from "../identity";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { assertLocalScopeSupported } from "../local-config";
import { assertNotPulledSkill } from "../remote-refusal";
import {
  METADATA_SIDECAR,
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
} from "../item-snapshot";
import { namedFilesEqual } from "../merge-tree";
import {
  CODEX_PROJECTION_ROOTS,
  commitDataRepoMutation,
} from "../marketplace-files";
import {
  hasCodexMarketplace,
  refreshCodexProjection,
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
import { sanitizeDisplayText } from "../pick-core";
import { unwatchedPathsForItem } from "../promote-catalog";

export interface PromoteOptions {
  message?: string;
  json?: boolean;
  local?: boolean;
  staleOk?: boolean;
  suppressGuidance?: boolean;
  /**
   * Not a CLI flag: pins the catalog's repo so `capshelf data bind` in another
   * terminal cannot move the destination.
   */
  boundRepo?: string;
  previewGuard?: PromotePreviewGuard;
  beforeCanonicalWrite?: () => Promise<void>;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
  staleOk?: boolean;
  snapshotHooks?: {
    afterSnapshotCaptured?: () => Promise<void>;
    beforeCanonicalCopy?: () => Promise<void>;
    afterCanonicalCopy?: () => Promise<void>;
  };
  previewGuard?: PromotePreviewGuard;
}

export async function promoteOne(
  itemRef: string,
  opts: PromoteOptions,
  cmd: Command,
): Promise<PromoteResult> {
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
  // Runs before data-repo resolution, which would exit 6 about an unbound shelf
  // in a project that holds only remote rows.
  await assertNotPulledSkill(project, ref, "promoting");
  const dataRepo =
    opts.boundRepo ?? (await resolveProjectDataRepo(project, manifest, cmd));

  let result: PromoteResult;
  let saveProject = false;
  let saveLocal = false;
  const writableLock = assertWritableLock(lock, "capshelf promote");
  const writableLocalLock = assertWritableLock(localLock, "capshelf promote");
  if (opts.local) {
    result = await promoteLocalTracked(
      project,
      dataRepo,
      writableLocalLock,
      ref,
      opts,
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
      opts,
    );
    saveProject = true;
  }

  if (saveProject) {
    await saveManifest(project, manifest);
    await saveLock(project, writableLock);
  }
  if (saveLocal) {
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
  console.log(
    `✓ ${result.action} data/${result.kind}/${result.name} @ ${result.sha}`,
  );
  console.log(`  source commit: ${result.sourceCommit}`);
  printRuntimeWarnings(result.runtimeWarnings);
  printPrivateDotenvWarnings(result.privateDotenvWarnings);
  if (result.committed && !opts.suppressGuidance) {
    await printShareUpstreamGuidance(dataRepo);
  }
  return result;
}

/**
 * Refuse before writing: an `--assume-unchanged` or `--skip-worktree` path
 * looks clean and promote would overwrite the hidden edit.
 */
async function assertGitWatchesItem(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<void> {
  const unwatched = await unwatchedPathsForItem(dataRepo, kind, name);
  if (unwatched.length > 0) {
    throw new PreconditionError(
      `git is not watching ${unwatched.join(", ")}; nothing was promoted for this item`,
    );
  }
}

async function promoteProjectTracked(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  projectLock: WritableLock,
  localLock: WritableLock,
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
  await assertGitWatchesItem(dataRepo, parsed.kind, parsed.name);
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
  lock: WritableLock,
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
      gitTreeSource({
        repo: dataRepo,
        kind: "subagents",
        name,
        commit: sourceCommit,
      }),
      "subagents",
      name,
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
        await ensureDir(dirname(path), dataRepoScope(dataRepo));
        await atomicWriteFile(path, raw, dataRepoScope(dataRepo));
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
  const pin = await pinItemAtCommit(
    gitTreeSource({
      repo: dataRepo,
      kind: "subagents",
      name,
      commit: sourceCommit,
    }),
    "subagents",
    name,
  );
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
  localLock: WritableLock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(localLock, ref, "data");
  if (!key) {
    if (ref.kind === undefined || installsAtSkillTarget(ref.kind)) {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not promoting ${ref.kind ?? "skills"}/${ref.name} — ${skillsShConflictMessage(external)}`,
        );
      }
    }
    throw new NotFoundError(`not tracked in local scope: ${refDisplay(ref)}`);
  }

  const parsed = parseLockKey(key);
  assertLocalScopeSupported(parsed.kind, parsed.name, "promote");
  await assertGitWatchesItem(dataRepo, parsed.kind, parsed.name);
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
  lock: WritableLock,
  ref: ReturnType<typeof parseItemRef>,
): Promise<never> {
  if (ref.kind === undefined || installsAtSkillTarget(ref.kind)) {
    const external = await findSkillsShSkill(project, ref.name);
    if (external) {
      throw new PreconditionError(
        `not promoting ${ref.kind ?? "skills"}/${ref.name} — ${skillsShConflictMessage(external)}`,
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
  lock: WritableLock,
  kind: FragmentItemKind,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryV4OrThrow(lock.items[key], key);
  const canonicalPaths = allCanonicalFragmentRelPaths(kind, name);
  // Throws a PreconditionError when the data repo has no canonical source
  // files, the expected empty case; real git or filesystem failures propagate.
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
  // Compute the digest from the tree committed at HEAD, so it compares with
  // `entry.sourcePinDigest`, which digests the (path, mode, blobId) tree
  // entries.
  const headCommittedSha = sourcePinDigest(
    await itemTreeEntriesAtCommit(
      gitTreeSource({
        repo: dataRepo,
        kind,
        name,
        commit: await headSha(dataRepo),
      }),
      kind,
    ),
  );
  if (!dirty) {
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

  // A differing digest means upstream advanced past the lock, and committing
  // would fold that advance into a lock bump the user never reviewed.
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
  // On failure restore only the index: the canonical file is the user's own
  // edit and restoring it would discard what is being promoted.
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
  // A hook or concurrent editor can change the worktree after the preview; the
  // transaction rolls back the commit but leaves the worktree bytes alone.
  const pin = await pinItemAtCommit(
    gitTreeSource({ repo: dataRepo, kind, name, commit: sourceCommit }),
    kind,
    name,
  );
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
  lock: WritableLock,
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

  if (installsAtSkillTarget(kind)) {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — ${skillsShConflictMessage(external)}`,
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
  const requiredFile =
    kind === "skills"
      ? "SKILL.md"
      : kind === "plugins"
        ? PLUGIN_MANIFEST_REL
        : "index.ts";
  const requiredFileStat = lstatOrNull(
    join(localPath, ...requiredFile.split("/")),
  );
  if (!requiredFileStat?.isFile()) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — required ${requiredFile} is missing or not a regular file`,
    );
  }
  if (!snapshot.files.includes(requiredFile)) {
    const rule =
      snapshot.source === "git-visible"
        ? await projectIgnoreRule(
            project,
            relative(project, join(localPath, ...requiredFile.split("/"))),
          )
        : null;
    if (rule) {
      throw new PreconditionError(
        `not promoting ${kind}/${name} — required ${requiredFile} is hidden by the ignore rule "${rule.pattern}" in ${rule.source}:${rule.line}`,
        {
          hint: `A project-scope promote reads only the files that Git can see. Remove the rule, or run "${PRODUCT_NAME} move ${kind}/${name} --to local" and then "${PRODUCT_NAME} promote ${kind}/${name} --local".`,
        },
      );
    }
    throw new PreconditionError(
      `not promoting ${kind}/${name} — required ${requiredFile} is not Git-visible in the installed snapshot`,
    );
  }
  // The manifest, not the directory, names a plugin; check before comparing
  // content so a renamed-upstream plugin refuses with both names.
  if (kind === "plugins") {
    const manifestName = await readPluginManifestName(
      join(localPath, ...PLUGIN_MANIFEST_REL.split("/")),
    );
    if (manifestName !== name) {
      throw new PreconditionError(
        manifestName === null
          ? `not promoting plugins/${name} — ${PLUGIN_MANIFEST_REL} has no "name" field`
          : `not promoting plugins/${name} — its plugin.json names it "${sanitizeDisplayText(manifestName)}"`,
      );
    }
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
  if (lockedCommit === null) {
    throw new PreconditionError(
      `not promoting ${kind}/${name} — the locked source commit is not available in the data repo`,
    );
  }
  const lockedFiles = await namedFilesAtCommit(
    dataRepo,
    repoRelPath,
    lockedCommit,
  );
  const installedMatchesPin =
    sourcePinDigest(
      namedFilesTreeEntries(
        localFiles,
        hashWidthOf(
          await itemTreeEntriesAtCommit(
            gitTreeSource({ repo: dataRepo, kind, name, commit: lockedCommit }),
            kind,
          ),
        ),
      ),
    ) === entry.sourcePinDigest;
  if (
    lockedFiles !== null &&
    installedMatchesPin &&
    namedFilesEqual(localFiles, lockedFiles)
  ) {
    // No guard needed when local content matches the lock; upstream advancing
    // past it is status's job to report.
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

  // Shares upstream facts with status so this gate and the state machine cannot
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
      const sourceCommit = await lastTouchingContentCommit(
        dataRepo,
        repoRelPath,
      );
      const needsSnapshot = await captureCommittedItemNeeds(dataRepo, {
        kind,
        name,
      });
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
  // Directory replace removes the data-repo .capshelf.yml, but projects never
  // receive the sidecar, so restore it unless the project copy supplies its
  // own.
  const dataDir = join(dataRepo, repoRelPath);
  const upstreamSidecar = await readSidecarBytes(dataDir);
  const codexConfigured = kind === "skills" && hasCodexMarketplace(dataRepo);
  const replaceSource = async (): Promise<string[]> => {
    await opts.snapshotHooks?.beforeCanonicalCopy?.();
    await replaceDirFromFiles(
      localPath,
      snapshot.files,
      dataDir,
      dataRepoScope(dataRepo),
    );
    const keptSidecar = await restoreSidecarBytes(
      dataDir,
      upstreamSidecar,
      dataRepoScope(dataRepo),
    );
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
    return keptSidecar ? [`${repoRelPath}/${METADATA_SIDECAR}`] : [];
  };
  const expectedHead = previewHead ?? (await headSha(dataRepo));
  // Compare the project snapshot against the tree the commit actually produced,
  // so hooks, clean filters or .gitattributes that rewrite content cannot
  // publish bytes the project never held; a refusal unwinds the commit.
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

/**
 * Promoting publishes the divergence that keep-local marks as intentional, so
 * the user must choose which they meant.
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
  // Item names come from untrusted lock/catalog data and may contain spaces or
  // `$`, so printed commands quote the ref via shellArg.
  const itemArg = shellArg(item);
  const shortCommit = input.sourceCommit.slice(0, 7);
  const scopeFlag = input.scope === "local" ? " --local" : "";
  const preserveHint =
    input.scope === "local"
      ? "  (preserve your current edits first; local-scope files are excluded from this project's Git):\n"
      : "  (preserve your current edits first; update replaces the installed copy):\n";
  // Update-time merge is the only choice that keeps both sides, so it comes
  // first; fragments and subagents do not support it.
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
      // Use the absolute path and quoted pathspec because this line is meant to
      // be pasted and `~` does not expand inside quotes.
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
