/**
 * The named share path: `capshelf share <item>`. `share.ts` registers the
 * command and sends a call here or to the picker in `share-interactive.ts`,
 * which runs each planned share through the same functions.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { atomicWriteFile, lstatOrNull } from "../fs-utils";
import { basename, dirname, join, relative } from "node:path";
import {
  capshelfCommandPrefix,
  homeRelative,
  projectRoot,
  shellArg,
} from "../paths";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { globalOpts } from "../global-options";
import {
  loadManifest,
  saveManifest,
  type Manifest,
  addManifestName,
} from "../manifest";
import {
  assertLockV4,
  createDataLockEntry,
  dataKey,
  entryIdentity,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntryV4, Lock } from "../lock";
import { pinItemAtCommit } from "../pin";
import type { PinnedSource } from "../pin";
import { gitTreeSource } from "../item-source";
import { assertCommittedTreeEqualsCandidate } from "../promote-proof";
import { isSystemItemName } from "../bundled";
import { isCopyDirectoryItemKind, itemRepoRelPath } from "../master";
import type { CopyDirectoryItemKind, FragmentItemKind } from "../master";
import { assertRepoClean, headSha, originRemoteUrl } from "../git";
import { commitDataRepoMutation } from "../marketplace-files";
import { PreconditionError } from "../errors";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import {
  addLocalConfigName,
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  removeLocalConfigName,
  removeLocalExcludes,
  saveLocalConfig,
} from "../local-config";
import { addToManifest } from "../promote-core";
import type { PromoteResult, Scope } from "../promote-core";
import {
  findPreviousOwner,
  previousOwnerFor,
  previousOwnerSearchPaths,
} from "../previous-owner";
import type { PreviousOwnerRecord } from "../previous-owner";
import { remoteCacheState } from "../remote-cache";
import { assertNotPulledSkill } from "../remote-refusal";
import { findLicense } from "../remote-discovery";
import { installedPath } from "../installed";
import { PRODUCT_NAME, METADATA_SIDECAR } from "../identity";
import { adoptIntoDataRepo } from "../data-repo-adopt";
import { printPrivateDotenvWarnings } from "../dotfiles";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import {
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  fragmentOutputSpec,
  fragmentSourceCandidates,
  fragmentValuesForTarget,
  isFragmentKind,
  parseFragmentSourceText,
  sourceMatchesCliTarget,
  sourceTargetForCli,
  type FragmentSource,
  type FragmentValue,
} from "../fragments";
import {
  itemTargetCoverageAtCommit,
  printTargetCoverage,
  targetCoverageJson,
} from "../target-coverage";
import {
  extractPickedFragment,
  mcpServerContainerKey,
  unmanagedRemainder,
} from "../fragment-pick";
import {
  isPlainConfigObject,
  mergeConfigObjects,
  type ConfigObject,
} from "../config-values";
import { captureCommittedItemNeeds } from "../metadata";
import {
  isSubagentTarget,
  subagentSourceCandidates,
  validateSubagentSource,
  type SubagentSource,
} from "../subagents";

type ShareScope = "project" | "local";

/** `share` tracks what it commits, so the `capshelf update` line always applies. */
const SHARED_COVERAGE = { presentWord: "present", tracked: true } as const;

export interface ShareOptions {
  to?: string;
  from?: string;
  pick?: string[];
  target?: string;
  message?: string;
  json?: boolean;
  /**
   * Not a CLI flag. The interactive loop shares several items in one run and
   * prints the data-repo guidance once at the end instead of once per item.
   */
  suppressGuidance?: boolean;
  /**
   * Not a CLI flag. The interactive loop pins the repository its catalog was
   * read from and shares into that one — the same pin `runInteractiveAdd`
   * holds — so `capshelf data bind` in another terminal while the picker is
   * open cannot move the destination under the marks.
   */
  boundRepo?: string;
  /** Take ownership from a previous owner: a remote row or a skills.sh row. */
  adopt?: boolean;
}

export async function shareOne(
  itemRef: string,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  const ref = parseItemRef(itemRef);
  if (isSystemItemName(ref.name)) {
    throw new PreconditionError(
      `"${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
    );
  }

  const kind = ref.kind ?? "skills";
  // Step 1 of the adopt ordering, and it has to be here rather than in
  // `shareCopyItem`: a fragment or subagent ref is routed away below and would
  // never reach it.
  if (opts.adopt === true && kind !== "skills") {
    throw new PreconditionError(
      `share --adopt supports skills only; ${kind}/${ref.name} is a ${kind} item`,
    );
  }
  const name = ref.name;
  const scope = parseShareScope(
    opts.to,
    kind === "skills" ? "local" : "project",
  );
  if (isFragmentKind(kind)) {
    await shareFragment(kind, name, scope, opts, cmd);
    return;
  }
  if (kind === "subagents") {
    await shareSubagent(name, scope, opts, cmd);
    return;
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no share strategy for ${kind}/${name}`);
  }
  await shareCopyItem(kind, name, scope, opts, cmd);
}

export async function shareCopyItem(
  kind: CopyDirectoryItemKind,
  name: string,
  scope: ShareScope,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (opts.pick !== undefined) {
    throw new PreconditionError(
      "--pick is only valid for fragment items (settings, mcp, codex-config)",
    );
  }
  // Step 2. `--adopt` takes what is already installed; the other three name a
  // different source, so pairing them would be two answers to one question.
  if (opts.adopt === true) {
    for (const [flag, value] of [
      ["--from", opts.from],
      ["--pick", opts.pick],
      ["--target", opts.target],
    ] as const) {
      if (value !== undefined) {
        throw new PreconditionError(
          `share --adopt cannot be combined with ${flag}`,
        );
      }
    }
  }

  if (scope === "local") {
    assertLocalScopeSupported(kind, name, "share");
  }

  // Step 3.
  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd });
  const localConfig = await loadLocalConfig(project);
  const key = dataKey(kind, name);
  const projectKey = lockKeyForRef(projectLock, { kind, name }, "data");
  const localKey = lockKeyForRef(localLock, { kind, name }, "data");

  // Steps 4 to 7. The order is the property that makes an interrupted run
  // recoverable, and every step here runs before the data repo is resolved:
  // pulling needs no shelf, and only adopting does.
  // A plain `share` of a pulled skill would commit its bytes to the shelf and
  // leave the remote row in place — the two-owner state the product itself
  // labels "an adopt did not finish" and fails `--strict` on, reached by a
  // documented command rather than by an interruption. `--adopt` is the one
  // path that transfers ownership, so every other shape refuses the way
  // promote, move, keep-local, and revert do. Above the data-repo resolution,
  // like those four: D7 allows a project with remote rows and no shelf.
  if (opts.adopt !== true) {
    await assertNotPulledSkill(project, { kind, name }, "sharing");
  }
  const owner =
    opts.adopt === true ? await findPreviousOwner(project, name) : null;
  if (opts.adopt === true) {
    if (owner === null && projectKey === null && localKey === null) {
      throw new PreconditionError(
        `nothing to adopt for ${kind}/${name}: no previous owner and no capshelf lock entry`,
        {
          hint: `searched:\n    ${previousOwnerSearchPaths(project).join("\n    ")}`,
        },
      );
    }
    if (projectKey && localKey) {
      throw new PreconditionError(
        `${kind}/${name} is tracked in both project and local scope`,
        { hint: `remove one owner first: ${PRODUCT_NAME} rm ${kind}/${name}` },
      );
    }
    if (projectKey ?? localKey) {
      await finishInterruptedAdopt({
        project,
        kind,
        name,
        key,
        trackedScope: projectKey ? "project" : "local",
        requestedScope: opts.to === undefined ? null : scope,
        lock: projectKey ? projectLock : localLock,
        owner,
        json: opts.json === true,
      });
      return;
    }
  }

  if (projectKey) {
    throw new PreconditionError(
      `already tracked in project scope: ${kind}/${name}`,
    );
  }
  // Step 8. This is where D7 ends: a missing binding exits 6. It sits below the
  // refusals above for every caller, not only for `--adopt`, so `share` has one
  // refusal precedence rather than two — and above the local-manifest check,
  // which is a write-time precondition rather than a boundary.
  const dataRepo =
    opts.boundRepo ?? (await resolveProjectDataRepo(project, manifest, cmd));

  if (scope === "local") {
    if (!localConfig) {
      throw new PreconditionError(
        "no local manifest exists; run capshelf init or capshelf set-data first",
      );
    }
    await assertLocalInstallPathsUntracked(project, kind, name);
  }

  const repoRelPath = itemRepoRelPath(kind, name);
  // Moved down with the resolution it reads: this refusal needs `dataRepo`.
  // Under `--adopt` it is replaced by the content comparison in
  // `adoptIntoDataRepo`, which treats identical content as convergence.
  if (opts.adopt !== true && existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo already has ${repoRelPath}; use promote to push edits, or move to change scope`,
    );
  }

  // Step 9, before any data-repo mutation. This assertion used to run after
  // `adoptIntoDataRepo`, so a legacy lock refused the share only after the
  // item was already committed — leaving a data-repo commit with no project
  // tracking.
  const writableProjectLock = assertLockV4(projectLock, "capshelf share");
  const writableLocalLock = assertLockV4(localLock, "capshelf share");

  if (owner !== null) await warnAboutMissingLicense(project, name, owner);

  // Before the snapshot, not after the commit, and unconditional the way
  // `move --to project` drops it. A project-scope adopt reads the installed
  // item through project Git, and `add <url>` excludes every pulled skill's
  // install path — so a line left in place makes Git report an empty directory
  // and the adopt writes nothing to copy. It has to go for the destination's
  // sake too: a project-scope item named in `.git/info/exclude` is skipped by
  // `git add -A`, and its unpinned extras are misclassified by
  // `visibleExtraPaths`, which reads that same ignore stack. Gating this on
  // `localKey` missed the case entirely, because a remote row is in neither
  // capshelf lock. A name that owns no line is a no-op here.
  // Only a line this command actually removed is restored below. Calling
  // `ensureLocalExcludes` unconditionally would write an exclude for an item
  // that never had one — a project-scope share of an ordinary unmanaged
  // directory would start hiding it from the project's own Git.
  const excludeDropped =
    scope === "project" && (await removeLocalExcludes(project, kind, name));

  // Steps 10 and 11.
  let adopted: PromoteResult;
  try {
    adopted = await adoptIntoDataRepo(project, dataRepo, kind, name, {
      installMode: manifest.installMode,
      message: opts.message,
      ...((scope === "local" || localKey) && {
        sourceScope: "local" as const,
      }),
      ...(opts.adopt === true && {
        allowExistingUpstream: true,
        allowPreviousOwner: true,
      }),
      ...(owner !== null && { provenance: owner.provenance }),
    });
  } catch (error) {
    // The item still belongs to whoever owned it before this command ran, and
    // that owner's install path is supposed to be invisible to project Git.
    // Leaving the line removed would let the next `git add -A` commit clone-
    // local files into the project, which is the one thing the exclude exists
    // to stop. A restore that itself fails must not replace the real error.
    if (excludeDropped) {
      await ensureLocalExcludes(project, kind, name).catch(() => {});
    }
    throw error;
  }

  const snapshot = await captureCommittedItemNeeds(dataRepo, {
    kind,
    name,
  });
  if (!adopted.pin) {
    throw new Error(`expected a verified pin for ${kind}/${name}`);
  }
  const entry = createDataLockEntry({ pin: adopted.pin, ...snapshot });
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
  let localChanged = false;
  if (scope === "project") {
    addToManifest(manifest, kind, name);
    writableProjectLock.items[key] = preserveLabel(entry, localLock, key);
    if (localKey) {
      delete writableLocalLock.items[key];
      if (localConfig) {
        removeLocalConfigName(localConfig, kind, name);
      }
      localChanged = true;
    }
    await saveManifest(project, manifest);
    await saveLock(project, writableProjectLock);
    if (localChanged) {
      await saveLocalLock(project, writableLocalLock);
      if (localConfig) await saveLocalConfig(project, localConfig);
    }
  } else {
    if (!localConfig) throw new Error("expected local manifest");
    addLocalConfigName(localConfig, kind, name);
    writableLocalLock.items[key] = preserveLabel(entry, localLock, key);
    await ensureLocalExcludes(project, kind, name);
    await saveLocalConfig(project, localConfig);
    await saveLocalLock(project, writableLocalLock);
  }

  // Step 12, last. A crash before this leaves two owners rather than none, and
  // a second run converges through `finishInterruptedAdopt` above.
  let released = false;
  if (owner !== null) {
    await previousOwnerFor(owner.kind).release(project, name, owner);
    released = true;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind,
          name,
          scope,
          action: adopted.action,
          sha: adopted.sha,
          sourceCommit: adopted.sourceCommit,
          committed: adopted.committed,
          needs: snapshot.needs,
          ...(owner !== null && {
            adoptedFrom: owner.kind,
            previousOwnerReleased: released,
          }),
          ...(runtimeWarnings.length > 0 && {
            runtimeWarnings,
          }),
          ...(adopted.privateDotenvWarnings && {
            privateDotenvWarnings: adopted.privateDotenvWarnings,
          }),
        },
        null,
        2,
      ),
    );
    return;
  }

  const verb = owner === null ? "shared" : "adopted";
  console.log(`✓ ${verb} ${scope}/data/${kind}/${name} @ ${adopted.sha}`);
  console.log(`  source commit: ${adopted.sourceCommit}`);
  if (owner !== null) {
    printAdoptProvenance(owner, kind, name);
    console.log(`  released: ${ownerLabel(owner)} for ${kind}/${name}`);
  }
  printRuntimeWarnings(runtimeWarnings);
  printPrivateDotenvWarnings(adopted.privateDotenvWarnings);
  if (!opts.suppressGuidance) await printShareUpstreamGuidance(dataRepo);
}

/**
 * Step 7: a capshelf entry already exists, so an earlier run reached step 11
 * and stopped before step 12. Release the previous owner and report the
 * convergence; nothing is committed, because the shelf already holds the item.
 */
async function finishInterruptedAdopt(input: {
  project: string;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  trackedScope: Scope;
  /** The scope `--to` asked for, or null when it was not given. */
  requestedScope: Scope | null;
  lock: Lock;
  owner: PreviousOwnerRecord | null;
  json: boolean;
}): Promise<void> {
  const { project, kind, name, trackedScope, owner } = input;
  if (input.requestedScope !== null && input.requestedScope !== trackedScope) {
    throw new PreconditionError(
      `${kind}/${name} is already tracked in ${trackedScope} scope; --to ${input.requestedScope} disagrees`,
      {
        hint: `move it instead: ${PRODUCT_NAME} move ${kind}/${name} --to ${input.requestedScope}`,
      },
    );
  }
  const entry = input.lock.items[input.key];
  const sha = entry ? entryIdentity(entry) : "(unknown)";
  const sourceCommit =
    entry?.source === "data" ? entry.sourceCommit : "(unknown)";
  let released = false;
  if (owner !== null) {
    await previousOwnerFor(owner.kind).release(project, name, owner);
    released = true;
  }
  if (input.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind,
          name,
          scope: trackedScope,
          action: "already-upstream",
          sha,
          sourceCommit,
          committed: false,
          ...(owner !== null && {
            adoptedFrom: owner.kind,
            previousOwnerReleased: released,
          }),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `= already upstream ${trackedScope}/data/${kind}/${name} @ ${sha}`,
  );
  console.log(
    "  the data repo already holds identical content, so nothing was committed",
  );
  if (owner !== null) {
    console.log(`  released: ${ownerLabel(owner)} for ${kind}/${name}`);
  }
}

function ownerLabel(owner: PreviousOwnerRecord): string {
  return owner.kind === "remote" ? "remote row" : "skills-lock.json row";
}

function printAdoptProvenance(
  owner: PreviousOwnerRecord,
  kind: CopyDirectoryItemKind,
  name: string,
): void {
  const { upstream, upstreamCommit, upstreamPath } = owner.provenance;
  if (upstream === null && upstreamCommit === null && upstreamPath === null) {
    return;
  }
  console.log(
    `  provenance recorded in ${itemRepoRelPath(kind, name)}/${METADATA_SIDECAR}:`,
  );
  if (upstream !== null) console.log(`      upstream:       ${upstream}`);
  if (upstreamCommit !== null) {
    console.log(`      upstreamCommit: ${upstreamCommit}`);
  }
  if (upstreamPath !== null) {
    console.log(`      upstreamPath:   ${upstreamPath}`);
  }
}

/**
 * D10's warning. A license inside the item travels with it; one at the
 * repository root does not, and a skill with neither is someone else's work
 * with no stated terms. It never blocks the adopt.
 */
async function warnAboutMissingLicense(
  project: string,
  name: string,
  owner: PreviousOwnerRecord,
): Promise<void> {
  const inspectedRoot =
    owner.kind === "remote" && owner.provenance.upstream !== null;
  const found = inspectedRoot
    ? await remoteLicense(owner)
    : installedLicense(project, name);
  if (found) return;
  // The root is named only when it was read. A skills.sh row carries a `source`
  // URL too, but capshelf clones nothing for it, so the other branch inspects
  // the installed directory alone — claiming the root was checked would be a
  // statement about work that never happened.
  console.error(
    `⚠ no license file in the pulled item${
      inspectedRoot ? ` or at the ${owner.provenance.upstream} root` : ""
    }`,
  );
  console.error(
    "  you are copying someone else's work into your shelf. Check the terms yourself.",
  );
}

async function remoteLicense(owner: PreviousOwnerRecord): Promise<boolean> {
  const upstream = owner.provenance.upstream;
  const commit = owner.provenance.upstreamCommit;
  const subpath = owner.provenance.upstreamPath;
  if (upstream === null || commit === null || subpath === null) return false;
  const cache = remoteCacheState(upstream);
  if (!cache.present) return false;
  // A cold cache cannot answer, and a warning nobody can act on is worse than
  // none, so an unreachable cache reports "found" and stays quiet.
  const finding = await findLicense(cache.path, commit, subpath).catch(
    () => null,
  );
  return finding === null || finding.path !== null;
}

function installedLicense(project: string, name: string): boolean {
  const root = installedPath(project, "skills", name);
  return ["LICENSE", "LICENSE.md", "LICENCE", "LICENCE.md", "COPYING"].some(
    (file) => existsSync(join(root, file)),
  );
}

export async function shareSubagent(
  name: string,
  scope: ShareScope,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (scope !== "project") {
    assertLocalScopeSupported("subagents", name, "share");
  }
  if (opts.pick !== undefined) {
    throw new PreconditionError("--pick is not supported for subagents");
  }
  if (opts.from && !opts.target) {
    throw new PreconditionError(
      `share subagents/${name} --from requires --target claude or --target codex`,
    );
  }
  if (opts.target !== undefined && !isSubagentTarget(opts.target)) {
    throw new PreconditionError(
      `invalid target "${opts.target}"; must be claude or codex`,
    );
  }

  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd });
  const dataRepo =
    opts.boundRepo ?? (await resolveProjectDataRepo(project, manifest, cmd));
  await assertRepoClean(dataRepo);
  const key = dataKey("subagents", name);
  if (projectLock.items[key] || localLock.items[key]) {
    throw new PreconditionError(
      `already tracked in this project: subagents/${name}`,
    );
  }
  // Before any data-repo mutation. This assertion used to run after the
  // commit, so a legacy lock refused the share only after the subagent was
  // already committed — leaving a data-repo commit with no project tracking.
  const writableProjectLock = assertLockV4(projectLock, "capshelf share");

  const allCandidates = subagentSourceCandidates(project, name);
  for (const candidate of allCandidates) {
    if (existsSync(join(dataRepo, ...candidate.relPath.split("/")))) {
      throw new PreconditionError(
        `data repo already has ${candidate.relPath}; use promote to push edits`,
      );
    }
  }
  const candidates = allCandidates.filter(
    (candidate) =>
      opts.target === undefined || candidate.target === opts.target,
  );
  const pending: Array<{ source: SubagentSource; raw: string }> = [];
  if (opts.from) {
    pending.push({
      source: candidates[0]!,
      raw: await readFile(opts.from, "utf-8"),
    });
  } else {
    for (const source of candidates) {
      const stat = lstatOrNull(source.outputPath);
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new PreconditionError(
          `cannot share subagents/${name} — runtime target is not a regular file: ${source.outputPath}`,
        );
      }
      pending.push({
        source,
        raw: await readFile(source.outputPath, "utf-8"),
      });
    }
  }
  if (pending.length === 0) {
    throw new PreconditionError(
      `share subagents/${name} found no unmanaged target outputs\n  expected ${candidates.map((source) => relative(project, source.outputPath)).join(" or ")}`,
    );
  }
  for (const { source, raw } of pending) {
    for (const warning of validateSubagentSource(source.target, name, raw)
      .warnings) {
      console.error(`⚠ ${warning}`);
    }
  }
  // A generated commit: capshelf chose these paths and wrote them, so the
  // transaction owns them and a failure removes them again. `verify` runs
  // inside it, so a hook that rewrites a shared file unwinds instead of
  // leaving the data repo holding content the project never had.
  let pin: PinnedSource | undefined;
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead: await headSha(dataRepo).catch(() => null),
    ownedRoots: pending.map(({ source }) => source.relPath),
    message: opts.message ?? `capshelf: subagents/${name}`,
    mutate: async () => {
      for (const { source, raw } of pending) {
        const path = join(dataRepo, ...source.relPath.split("/"));
        await mkdir(dirname(path), { recursive: true });
        await atomicWriteFile(path, raw);
      }
    },
    // PIN-11: the candidate was generated from the project's own files, so
    // what the commit holds must equal what was read. `pending` is `A`.
    verify: async (commit) => {
      pin = await assertCommittedTreeEqualsCandidate({
        dataRepo,
        kind: "subagents",
        name,
        commit,
        candidateFiles: pending.map(({ source, raw }) => ({
          path: basename(source.relPath),
          content: Buffer.from(raw, "utf-8"),
          mode: "100644" as const,
        })),
      });
    },
  });
  if (!pin) throw new Error(`expected a verified pin for subagents/${name}`);
  const sha = pin.sourcePinDigest;
  // `share` lists the canonical sources it wrote, so a one-target share
  // reported no absence at the moment the item was authored — the same
  // filtered-list blindness `add` had.
  const coverage = await itemTargetCoverageAtCommit(
    project,
    dataRepo,
    "subagents",
    name,
    sourceCommit,
  );
  const snapshot = await captureCommittedItemNeeds(dataRepo, {
    kind: "subagents",
    name,
  });
  addManifestName(manifest, "subagents", name);
  writableProjectLock.items[key] = createDataLockEntry({ pin, ...snapshot });
  await saveManifest(project, manifest);
  await saveLock(project, writableProjectLock);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind: "subagents",
          name,
          scope: "project",
          action: "created",
          sha,
          sourceCommit,
          committed: true,
          sources: pending.map(({ source }) => ({
            target: source.target,
            sourcePath: source.relPath,
            outputPath: source.outputPath,
          })),
          ...(coverage && targetCoverageJson(coverage, project)),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`✓ shared project/data/subagents/${name} @ ${sha}`);
  console.log(`  source commit: ${sourceCommit}`);
  for (const { source } of pending) console.log(`  ${source.relPath}`);
  if (coverage)
    printTargetCoverage(coverage, `subagents/${name}`, SHARED_COVERAGE);
  if (!opts.suppressGuidance) await printShareUpstreamGuidance(dataRepo);
}

export async function shareFragment(
  kind: FragmentItemKind,
  name: string,
  scope: ShareScope,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (scope !== "project") {
    assertLocalScopeSupported(kind, name, "share");
  }
  const explicitPicks = opts.pick ?? [];
  if (opts.from && explicitPicks.length > 0) {
    throw new PreconditionError(
      `share ${kind}/${name} accepts either --from or --pick, not both`,
    );
  }
  if (!opts.from && explicitPicks.length === 0 && kind !== "mcp") {
    throw new PreconditionError(
      `share ${kind}/${name} requires --from <path> or --pick <path>; managed values in generated outputs cannot be converted back to one fragment safely`,
    );
  }
  // For mcp items the item name doubles as the default server pick.
  const picks =
    !opts.from && explicitPicks.length === 0 ? [name] : explicitPicks;
  const cliTarget = sourceTargetForCli(opts.target);
  if (kind !== "mcp" && cliTarget !== null) {
    throw new PreconditionError("--target is only valid for mcp fragments");
  }
  if (kind === "mcp" && cliTarget === null && opts.from) {
    throw new PreconditionError(
      `share mcp/${name} --from requires --target claude or --target codex`,
    );
  }

  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  // Before any data-repo mutation. This assertion used to run after the
  // commit, so a legacy lock refused the share only after the fragment was
  // already committed — leaving a data-repo commit with no project tracking.
  const writableProjectLock = assertLockV4(projectLock, "capshelf share");
  const oldManifest = structuredClone(manifest);
  const oldLock = structuredClone(projectLock);
  const dataRepo =
    opts.boundRepo ?? (await resolveProjectDataRepo(project, manifest, cmd));
  await assertRepoClean(dataRepo);

  const candidates = fragmentSourceCandidates(kind, name).filter((candidate) =>
    sourceMatchesCliTarget(candidate, cliTarget),
  );
  const [firstCandidate] = candidates;
  if (!firstCandidate) {
    throw new PreconditionError(
      `no canonical source target for ${kind}/${name}`,
    );
  }
  const pending = opts.from
    ? [{ source: firstCandidate, raw: await readFile(opts.from, "utf-8") }]
    : await extractPickedSources({
        project,
        dataRepo,
        manifest,
        lock: projectLock,
        name,
        candidates,
        picks,
        autoTarget: kind === "mcp" && cliTarget === null,
      });

  // Validate every source before writing any, so a bad target leaves the
  // data repo untouched.
  for (const { source, raw } of pending) {
    const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
    if (existsSync(canonicalPath)) {
      throw new PreconditionError(
        `fragment source already exists: ${source.relPath}`,
      );
    }
    parseFragmentSourceText(source, raw);
  }
  // A generated commit: share chose these canonical paths and wrote them, so
  // the transaction owns them and a rejected commit takes them back out. The
  // alternative leaves an untracked source behind that the retry then refuses
  // as already existing.
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead: await headSha(dataRepo).catch(() => null),
    ownedRoots: pending.map(({ source }) => source.relPath),
    message: opts.message ?? `capshelf: ${kind}/${name}`,
    mutate: async () => {
      for (const { source, raw } of pending) {
        const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
        await mkdir(dirname(canonicalPath), { recursive: true });
        await atomicWriteFile(canonicalPath, raw);
      }
    },
  });
  // Fragments have no project snapshot: `share --from` writes the user's own
  // file into the data repo and commits it in place, so PIN-11's `A == B` has
  // no `A` to compare — the pending set can be a subset of the canonical paths
  // the item ends up with. The pin still comes from the committed tree.
  const pin = await pinItemAtCommit(
    gitTreeSource({ repo: dataRepo, kind, name, commit: sourceCommit }),
    kind,
    name,
  );
  const sha = pin.sourcePinDigest;

  addManifestName(manifest, kind, name);
  writableProjectLock.items[dataKey(kind, name)] = createDataLockEntry({
    pin,
    ...(await captureCommittedItemNeeds(dataRepo, { kind, name })),
  });

  const sources = await currentFragmentSourcesForItem(dataRepo, kind, name);
  const outputResults: Awaited<ReturnType<typeof applyFragmentOutput>>[] = [];
  for (const target of new Set(
    sources.map((fragmentSource) => fragmentSource.target),
  )) {
    outputResults.push(
      await applyFragmentOutput({
        project,
        dataRepo,
        manifest,
        oldManifest,
        nextManifest: manifest,
        oldLock,
        nextLock: projectLock,
        target,
      }),
    );
  }

  await saveManifest(project, manifest);
  await saveLock(project, writableProjectLock);

  const coverage = await itemTargetCoverageAtCommit(
    project,
    dataRepo,
    kind,
    name,
    sourceCommit,
  );
  // The non-interactive command that repeats this share. For a user who read
  // the picker's output to learn the CLI, this line is the deliverable; in
  // `--json` a script records what a human did. A `--from` share has no
  // repeatable command — the file it read may be gone.
  const equivalentCommand = opts.from
    ? null
    : shareCommandLine({
        ref: `${kind}/${name}`,
        picks: explicitPicks,
        target: cliTarget,
        message: opts.message,
        dataOverride: globalOpts(cmd).data,
      });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          verb: "share",
          kind,
          name,
          scope: "project",
          action: "created",
          sha,
          sourceCommit,
          committed: true,
          ...(picks.length > 0 && { picks }),
          ...(equivalentCommand !== null && { equivalentCommand }),
          sources: sources.map((fragmentSource) => ({
            target: fragmentSource.sourceTarget ?? fragmentSource.target,
            sourcePath: fragmentSource.relPath,
            outputPath: fragmentOutputPath(project, fragmentSource.target),
            outputAction:
              outputResults.find(
                (result) => result.target === fragmentSource.target,
              )?.action ?? "already-current",
          })),
          ...(coverage && targetCoverageJson(coverage, project)),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`✓ shared project/data/${kind}/${name} @ ${sha}`);
  console.log(`  source commit: ${sourceCommit}`);
  for (const fragmentSource of sources) {
    console.log(`  ${fragmentSource.relPath}`);
  }
  if (equivalentCommand !== null) console.log(`  ${equivalentCommand}`);
  if (coverage)
    printTargetCoverage(coverage, `${kind}/${name}`, SHARED_COVERAGE);
  if (!opts.suppressGuidance) await printShareUpstreamGuidance(dataRepo);
}

/**
 * The command that would repeat a share: the printed equivalent after a
 * success and the retry line after a failure. Arguments go through `shellArg`:
 * pick paths come from the user's own config files and can hold a space or a
 * `$`, and a printed command must survive being pasted. The commit message is
 * included because the command claims to repeat the share, and the message is
 * part of what it did.
 */
export function shareCommandLine(opts: {
  ref: string;
  picks: readonly string[];
  target: string | null;
  message: string | undefined;
  dataOverride: string | undefined;
}): string {
  const parts = [
    `${capshelfCommandPrefix(opts.dataOverride)} share ${shellArg(opts.ref)}`,
  ];
  for (const pick of opts.picks) parts.push(`--pick ${shellArg(pick)}`);
  if (opts.target !== null) parts.push(`--target ${opts.target}`);
  if (opts.message !== undefined) parts.push(`-m ${shellArg(opts.message)}`);
  return parts.join(" ");
}

export async function printShareUpstreamGuidance(
  dataRepo: string,
): Promise<void> {
  const origin = await originRemoteUrl(dataRepo);
  console.log("");
  console.log("committed to local data repo:");
  console.log(`  ${homeRelative(dataRepo)}`);
  if (origin !== null) {
    console.log("");
    console.log("to share upstream:");
    // The absolute path through `shellArg`, per its contract: this line is a
    // command to paste, and a repo path may hold a space or a `$`.
    console.log(`  cd ${shellArg(dataRepo)}`);
    console.log("  git push");
  }
}

interface PendingFragmentSource {
  source: FragmentSource;
  raw: string;
}

interface PickExtractionOptions {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  lock: Lock;
  name: string;
  candidates: FragmentSource[];
  picks: string[];
  autoTarget: boolean;
}

async function extractPickedSources(
  opts: PickExtractionOptions,
): Promise<PendingFragmentSource[]> {
  if (!opts.autoTarget) {
    // SAFETY: the one caller refuses an empty candidate list before it calls
    // this function (the `firstCandidate` check in `shareFragment`), so the
    // first candidate exists.
    const source = opts.candidates[0] as FragmentSource;
    const remainder = await loadOutputRemainder(opts, source);
    if (remainder === null) {
      throw new PreconditionError(
        `--pick requires ${outputLabelFor(opts.project, source)} to exist; nothing to extract from`,
      );
    }
    return [{ source, raw: extractFromRemainder(remainder, opts.picks) }];
  }

  // mcp with no --target: share from every output that contains the picks.
  const pending: PendingFragmentSource[] = [];
  const failures: string[] = [];
  for (const source of opts.candidates) {
    const remainder = await loadOutputRemainder(opts, source);
    if (remainder === null) {
      failures.push(`${outputLabelFor(opts.project, source)} does not exist`);
      continue;
    }
    try {
      pending.push({
        source,
        raw: extractFromRemainder(remainder, opts.picks),
      });
    } catch (err) {
      if (!(err instanceof PreconditionError)) throw err;
      const names = unmanagedServerNames(remainder);
      failures.push(
        names.length > 0
          ? `${err.message} (unmanaged servers: ${names.join(", ")})`
          : err.message,
      );
    }
  }
  if (pending.length === 0) {
    throw new PreconditionError(
      [
        `share mcp/${opts.name} found no unmanaged server to extract`,
        ...failures.map((failure) => `  ${failure}`),
      ].join("\n"),
    );
  }
  return pending;
}

interface OutputRemainder {
  source: FragmentSource;
  spec: ReturnType<typeof fragmentOutputSpec>;
  outputLabel: string;
  current: ConfigObject;
  managed: ConfigObject;
  managedFragments: FragmentValue[];
}

async function loadOutputRemainder(
  opts: Pick<
    PickExtractionOptions,
    "project" | "dataRepo" | "manifest" | "lock"
  >,
  source: FragmentSource,
): Promise<OutputRemainder | null> {
  const spec = fragmentOutputSpec(source.target);
  const outputPath = spec.outputPath(opts.project);
  const outputLabel = relative(opts.project, outputPath);
  if (!existsSync(outputPath)) return null;
  const current = spec.parse(await readFile(outputPath, "utf-8"), outputLabel);
  const managedFragments = await fragmentValuesForTarget({
    dataRepo: opts.dataRepo,
    manifest: opts.manifest,
    lock: opts.lock,
    target: source.target,
  });
  const managed = spec.normalizeOutput(
    mergeConfigObjects(managedFragments.map((fragment) => fragment.value)),
  );
  return { source, spec, outputLabel, current, managed, managedFragments };
}

function extractFromRemainder(
  remainder: OutputRemainder,
  picks: string[],
): string {
  return remainder.spec.stringify(
    extractPickedFragment({
      source: remainder.source,
      picks,
      current: remainder.current,
      managed: remainder.managed,
      managedFragments: remainder.managedFragments,
      outputLabel: remainder.outputLabel,
    }),
  );
}

function unmanagedServerNames(remainder: OutputRemainder): string[] {
  const base = unmanagedRemainder(remainder.current, remainder.managed);
  const servers = base[mcpServerContainerKey(remainder.source.sourceTarget)];
  return isPlainConfigObject(servers) ? Object.keys(servers) : [];
}

function outputLabelFor(project: string, source: FragmentSource): string {
  return relative(
    project,
    fragmentOutputSpec(source.target).outputPath(project),
  );
}

function parseShareScope(
  value: string | undefined,
  fallback: ShareScope,
): ShareScope {
  if (value === undefined) return fallback;
  if (value === "local" || value === "project") return value;
  throw new PreconditionError(
    `invalid scope "${value}" (expected local or project)`,
  );
}

function preserveLabel(
  entry: DataLockEntryV4,
  localLock: Lock,
  key: string,
): DataLockEntryV4 {
  const existing = localLock.items[key];
  if (existing?.source !== "data" || existing.label === undefined) {
    return entry;
  }
  return { ...entry, label: existing.label };
}
