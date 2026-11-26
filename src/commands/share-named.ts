import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, ensureDir, lstatOrNull } from "../fs-utils";
import { dataRepoScope } from "../path-safety";
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
  assertWritableLock,
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
import {
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  itemRepoRelPath,
  PLUGIN_MANIFEST_REL,
} from "../master";
import type {
  CopyDirectoryItemKind,
  FragmentItemKind,
  SkillTargetKind,
} from "../master";
import {
  assertRepoClean,
  headSha,
  originRemoteUrl,
  projectIgnoreRule,
} from "../git";
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
  trackedLocalInstallPath,
} from "../local-config";
import { addToManifest } from "../promote-core";
import type { AdoptionCandidate, PromoteResult, Scope } from "../promote-core";
import {
  findPreviousOwner,
  previousOwnerFor,
  previousOwnerSearchPaths,
} from "../previous-owner";
import type { PreviousOwnerRecord } from "../previous-owner";
import { remoteCacheState } from "../remote-cache";
import { assertNotPulledSkill } from "../remote-refusal";
import { findLicense } from "../remote-discovery";
import { loadRemotesLock, remoteKey } from "../remotes-lock";
import { assertSkillTargetFree } from "../skill-target";
import { confirmPluginConsent } from "../plugin-consent";
import { itemPluginRunsFromFiles } from "../plugin-runs";
import { sanitizeDisplayText } from "../pick-core";
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
  isConfigObject,
  isConfigString,
  isPlainConfigObject,
  mergeConfigObjects,
  type ConfigObject,
  type ConfigValue,
} from "../config-values";
import { captureCommittedItemNeeds, readSidecarBytes } from "../metadata";
import {
  isSubagentTarget,
  subagentSourceCandidates,
  validateSubagentSource,
  type SubagentSource,
} from "../subagents";

type ShareScope = "project" | "local";

const SHARED_COVERAGE = { presentWord: "present", tracked: true } as const;

export interface ShareOptions {
  to?: string;
  from?: string;
  pick?: string[];
  target?: string;
  message?: string;
  json?: boolean;
  suppressGuidance?: boolean;
  /**
   * Pins the repo the catalog was read from so `capshelf data bind` elsewhere
   * while the picker is open cannot move the destination.
   */
  boundRepo?: string;
  adopt?: boolean;
  yes?: boolean;
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
  // Checked here rather than in `shareCopyItem` because fragment and subagent
  // refs are routed away below and never reach it.
  if (opts.adopt === true && !installsAtSkillTarget(kind)) {
    throw new PreconditionError(
      `share --adopt supports skills and plugins only; ${kind}/${ref.name} is a ${kind} item`,
    );
  }
  const name = ref.name;
  const requestedScope = parseShareScope(opts.to);
  if (isFragmentKind(kind)) {
    await shareFragment(kind, name, requestedScope ?? "project", opts, cmd);
    return;
  }
  if (kind === "subagents") {
    await shareSubagent(name, requestedScope ?? "project", opts, cmd);
    return;
  }
  if (!isCopyDirectoryItemKind(kind)) {
    throw new Error(`no share strategy for ${kind}/${name}`);
  }
  await shareCopyItem(kind, name, requestedScope, opts, cmd);
}

/**
 * Skills and plugins default to local scope unless project Git tracks their
 * install path, since teammates already have the files and `.git/info/exclude`
 * cannot hide them.
 */
export async function defaultCopyItemShareScope(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
): Promise<{ scope: ShareScope; trackedPath: string | null }> {
  if (!installsAtSkillTarget(kind)) {
    return { scope: "project", trackedPath: null };
  }
  const trackedPath = await trackedLocalInstallPath(project, kind, name);
  return { scope: trackedPath === null ? "local" : "project", trackedPath };
}

export async function shareCopyItem(
  kind: CopyDirectoryItemKind,
  name: string,
  requestedScope: ShareScope | null,
  opts: ShareOptions,
  cmd: Command,
): Promise<void> {
  if (opts.pick !== undefined) {
    throw new PreconditionError(
      "--pick is only valid for fragment items (settings, mcp, codex-config)",
    );
  }
  // `--adopt` takes what is already installed; the other flags name a different
  // source, so pairing them gives two answers to one question.
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

  if (requestedScope === "local") {
    assertLocalScopeSupported(kind, name, "share");
  }

  const { project, manifest, projectLock, localLock } =
    await loadProjectContext({ cmd });
  const { scope, trackedPath } =
    requestedScope === null
      ? await defaultCopyItemShareScope(project, kind, name)
      : { scope: requestedScope, trackedPath: null };
  const localConfig = await loadLocalConfig(project);
  const key = dataKey(kind, name);
  const projectKey = lockKeyForRef(projectLock, { kind, name }, "data");
  const localKey = lockKeyForRef(localLock, { kind, name }, "data");

  // Refuse non-adopt shares of a remote skill before resolving the data repo:
  // committing its bytes would leave the remote row in place, the two-owner
  // state reported as an unfinished adopt.
  if (opts.adopt !== true) {
    await assertNotPulledSkill(project, { kind, name }, "sharing");
  }
  const owner =
    opts.adopt === true && installsAtSkillTarget(kind)
      ? await findPreviousOwner(project, kind, name)
      : null;
  if (opts.adopt === true) {
    if (owner === null && projectKey === null && localKey === null) {
      const searched = installsAtSkillTarget(kind)
        ? previousOwnerSearchPaths(project, kind)
        : [];
      throw new PreconditionError(
        `nothing to adopt for ${kind}/${name}: no previous owner and no capshelf lock entry`,
        {
          hint: `searched:\n    ${searched.join("\n    ")}`,
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
        requestedScope,
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
  // Missing-binding refusal sits below the other refusals for every caller so
  // `share` has one refusal precedence, and above the local-manifest check,
  // which is a write-time precondition.
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
  // Under `--adopt` this refusal is replaced by the content comparison in
  // `adoptIntoDataRepo`, which treats identical content as convergence.
  if (opts.adopt !== true && existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo already has ${repoRelPath}; use promote to push edits, or move to change scope`,
    );
  }

  // Assert the lock is writable before any data-repo mutation, or a legacy lock
  // would refuse after the item is committed, leaving a commit with no project
  // tracking.
  const writableProjectLock = assertWritableLock(projectLock, "capshelf share");
  const writableLocalLock = assertWritableLock(localLock, "capshelf share");

  // Guard every share that acquires the skill-target folder, not just remote
  // adopts: a plugin share beside a tracked `skills/<n>` finds no plugin lock
  // entry, and only this folder check stops a second owner.
  if (installsAtSkillTarget(kind)) {
    const self =
      owner?.kind === "remote"
        ? { key: remoteKey(kind, name) }
        : localKey !== null
          ? { key: localKey }
          : null;
    await assertSkillTargetFree(
      project,
      kind,
      name,
      {
        project: projectLock,
        local: localLock,
        remotes: await loadRemotesLock(project),
      },
      self,
      { ignoreSkillsSh: kind === "skills" },
    );
  }
  const checkCandidate = installsAtSkillTarget(kind)
    ? async (candidate: AdoptionCandidate): Promise<void> => {
        const approved = await checkPluginShareCandidate(
          project,
          kind,
          name,
          scope,
          candidate,
          { json: opts.json === true, yes: opts.yes === true },
        );
        if (!approved) throw new ShareDeclined();
      }
    : undefined;

  if (owner !== null) await warnAboutMissingLicense(project, kind, name, owner);

  // Drop the exclude line before the snapshot: `add <url>` excludes remote
  // install paths, so Git would report an empty directory, and a project-scope
  // item in `.git/info/exclude` is skipped by `git add -A`. Restore only a line
  // actually removed.
  const excludeDropped =
    scope === "project" && (await removeLocalExcludes(project, kind, name));

  // Keep the restore window open until the lock names the new owner: a failure
  // earlier would leave the previous owner's clone-local files staged by the
  // next `git add -A`.
  let adopted: PromoteResult;
  let snapshot: Awaited<ReturnType<typeof captureCommittedItemNeeds>>;
  let localChanged = false;
  let ownerEstablished = false;
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
      ...(checkCandidate !== undefined && { checkCandidate }),
    });

    snapshot = await captureCommittedItemNeeds(dataRepo, { kind, name });
    if (!adopted.pin) {
      throw new Error(`expected a verified pin for ${kind}/${name}`);
    }
    const entry = createDataLockEntry({ pin: adopted.pin, ...snapshot });
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
    ownerEstablished = true;
  } catch (error) {
    // A restore that itself fails must not replace the real error.
    if (excludeDropped && !ownerEstablished) {
      await ensureLocalExcludes(project, kind, name).catch(() => {});
    }
    if (error instanceof ShareDeclined) return;
    throw error;
  }
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  // Release the previous owner last: a crash before this leaves two owners
  // rather than none, and a rerun converges via `finishInterruptedAdopt`.
  let released = false;
  if (owner !== null) {
    await releasePreviousOwner(project, kind, name, owner);
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
  if (trackedPath !== null) {
    console.log(`  project scope: git already tracks ${trackedPath}`);
  }
  if (owner !== null) {
    await printAdoptProvenance(owner, dataRepo, kind, name, adopted.committed);
    console.log(`  released: ${ownerLabel(owner)} for ${kind}/${name}`);
  }
  printRuntimeWarnings(runtimeWarnings);
  printPrivateDotenvWarnings(adopted.privateDotenvWarnings);
  if (!opts.suppressGuidance) await printShareUpstreamGuidance(dataRepo);
}

async function finishInterruptedAdopt(input: {
  project: string;
  kind: CopyDirectoryItemKind;
  name: string;
  key: string;
  trackedScope: Scope;
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
    await releasePreviousOwner(project, kind, name, owner);
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

async function releasePreviousOwner(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  owner: PreviousOwnerRecord,
): Promise<void> {
  if (!installsAtSkillTarget(kind)) {
    throw new Error(`no previous owner can hold ${kind}/${name}`);
  }
  await previousOwnerFor(owner.kind).release(project, kind, name, owner);
}

class ShareDeclined extends Error {
  constructor() {
    super("share declined");
  }
}

/**
 * A plugin candidate must carry `.claude-plugin/plugin.json` whose name matches
 * the item, because Claude Code names the plugin from it.
 */
async function checkPluginShareCandidate(
  project: string,
  kind: SkillTargetKind,
  name: string,
  scope: ShareScope,
  candidate: AdoptionCandidate,
  opts: { json: boolean; yes: boolean },
): Promise<boolean> {
  if (kind === "plugins") {
    const file = candidate.files.find(
      (entry) => entry.path === PLUGIN_MANIFEST_REL,
    );
    if (file === undefined) {
      throw await missingManifestRefusal(project, name, candidate);
    }
    let parsed: ConfigValue = null;
    try {
      parsed = JSON.parse(file.content.toString("utf8"));
    } catch {
      // An unparseable manifest names no plugin.
    }
    const manifestName =
      isConfigObject(parsed) && isConfigString(parsed.name)
        ? parsed.name
        : null;
    if (manifestName !== name) {
      throw new PreconditionError(
        manifestName === null
          ? `not sharing plugins/${name} — ${PLUGIN_MANIFEST_REL} has no "name" field`
          : `not sharing plugins/${name} — its plugin.json names it "${sanitizeDisplayText(manifestName)}"`,
        {
          hint: `the item name is "${name}". ${PRODUCT_NAME} does not rename an item.`,
        },
      );
    }
  }
  if (scope !== "project") return true;
  const runs = await itemPluginRunsFromFiles(kind, candidate.files);
  if (runs === null) return true;
  return confirmPluginConsent(
    [{ kind: "project-scope", ref: `${kind}/${name}`, runs }],
    { json: opts.json, yes: opts.yes },
  );
}

/**
 * When the manifest is on disk but missing from the snapshot, an ignore rule
 * hid it: Git's rules for a project-scope share, the plugin folder's own
 * `.gitignore` for local scope.
 */
async function missingManifestRefusal(
  project: string,
  name: string,
  candidate: AdoptionCandidate,
): Promise<PreconditionError> {
  const manifestPath = join(candidate.path, ...PLUGIN_MANIFEST_REL.split("/"));
  if (!lstatOrNull(manifestPath)?.isFile()) {
    return new PreconditionError(
      `not sharing plugins/${name} — required ${PLUGIN_MANIFEST_REL} is missing or not a regular file`,
    );
  }
  const rule =
    candidate.snapshot.source === "git-visible"
      ? await projectIgnoreRule(project, relative(project, manifestPath))
      : null;
  const where =
    rule !== null
      ? `the ignore rule "${sanitizeDisplayText(rule.pattern)}" in ${sanitizeDisplayText(rule.source)}:${rule.line}`
      : `an ignore rule in ${relative(project, join(candidate.path, ".gitignore"))}`;
  return new PreconditionError(
    `not sharing plugins/${name} — ${PLUGIN_MANIFEST_REL} exists, but ${where} keeps it out of the share`,
    {
      hint: "A shared plugin needs its manifest on the shelf. Remove the rule, then share again.",
    },
  );
}

function ownerLabel(owner: PreviousOwnerRecord): string {
  return owner.kind === "remote" ? "remote row" : "skills-lock.json row";
}

/**
 * Report what the sidecar holds, not what the adopt intended: the converging
 * `already-upstream` path writes nothing, so claiming provenance was recorded
 * would be false.
 */
async function printAdoptProvenance(
  owner: PreviousOwnerRecord,
  dataRepo: string,
  kind: CopyDirectoryItemKind,
  name: string,
  committed: boolean,
): Promise<void> {
  const { upstream, upstreamCommit, upstreamPath } = owner.provenance;
  if (upstream === null && upstreamCommit === null && upstreamPath === null) {
    return;
  }
  if (!committed) {
    const sidecar = await readSidecarBytes(
      join(dataRepo, itemRepoRelPath(kind, name)),
    );
    const recorded =
      sidecar !== null && /^upstream:/m.test(sidecar.toString("utf-8"));
    console.log(
      recorded
        ? `  provenance already in ${itemRepoRelPath(kind, name)}/${METADATA_SIDECAR}, from the run that committed this item`
        : `  ⚠ no provenance in ${itemRepoRelPath(kind, name)}/${METADATA_SIDECAR}; the shelf already held this content, so nothing was committed`,
    );
    if (!recorded) {
      console.log(
        `      it came from: ${sanitizeDisplayText(upstream ?? "(unknown)")}`,
      );
    }
    return;
  }
  console.log(
    `  provenance recorded in ${itemRepoRelPath(kind, name)}/${METADATA_SIDECAR}:`,
  );
  if (upstream !== null) {
    console.log(`      upstream:       ${sanitizeDisplayText(upstream)}`);
  }
  if (upstreamCommit !== null) {
    console.log(`      upstreamCommit: ${upstreamCommit}`);
  }
  if (upstreamPath !== null) {
    console.log(`      upstreamPath:   ${sanitizeDisplayText(upstreamPath)}`);
  }
}

/**
 * A license inside the item travels with it, but one at the repo root does not;
 * warn without blocking.
 */
async function warnAboutMissingLicense(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
  owner: PreviousOwnerRecord,
): Promise<void> {
  const inspectedRoot =
    owner.kind === "remote" && owner.provenance.upstream !== null;
  const found = inspectedRoot
    ? await remoteLicense(owner)
    : { present: installedLicense(project, kind, name), insideItem: true };
  // The adopt copies only the plugin folder, so a license at the repository
  // root stays behind.
  if (found.present && !found.insideItem && kind === "plugins") {
    console.error(
      `⚠ the license is at the ${sanitizeDisplayText(owner.provenance.upstream ?? "upstream")} root${found.label ? ` (${found.label})` : ""}, not in the plugin`,
    );
    console.error(
      "  you are copying someone else's work into your shelf. Check the terms yourself.",
    );
    return;
  }
  if (found.present) return;
  // Name the root only when it was read: skills.sh rows have a `source` URL but
  // capshelf clones nothing, so only the installed directory was inspected.
  console.error(
    `⚠ no license file in the remote item${
      inspectedRoot
        ? ` or at the ${sanitizeDisplayText(owner.provenance.upstream ?? "upstream")} root`
        : ""
    }`,
  );
  console.error(
    "  you are copying someone else's work into your shelf. Check the terms yourself.",
  );
}

interface LicensePresence {
  present: boolean;
  insideItem: boolean;
  label?: string | null;
}

async function remoteLicense(
  owner: PreviousOwnerRecord,
): Promise<LicensePresence> {
  const missing = { present: false, insideItem: false };
  const upstream = owner.provenance.upstream;
  const commit = owner.provenance.upstreamCommit;
  const subpath = owner.provenance.upstreamPath;
  if (upstream === null || commit === null || subpath === null) return missing;
  const cache = remoteCacheState(upstream);
  if (!cache.present) return missing;
  // Treat a failed license lookup as found: a warning nobody can act on is
  // worse than none.
  const finding = await findLicense(cache.path, commit, subpath).catch(
    () => null,
  );
  if (finding === null) return { present: true, insideItem: true };
  if (finding.path === null) return missing;
  return {
    present: true,
    insideItem: finding.insideItem,
    label: finding.label,
  };
}

function installedLicense(
  project: string,
  kind: CopyDirectoryItemKind,
  name: string,
): boolean {
  const root = installedPath(project, kind, name);
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
  // Assert the lock is writable before any data-repo mutation, or a legacy lock
  // would refuse after the subagent is already committed.
  const writableProjectLock = assertWritableLock(projectLock, "capshelf share");

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
  // Generated commit: the transaction owns these paths and `verify` runs inside
  // it, so a hook that rewrites a shared file unwinds instead of leaving unseen
  // content.
  let pin: PinnedSource | undefined;
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead: await headSha(dataRepo).catch(() => null),
    ownedRoots: pending.map(({ source }) => source.relPath),
    message: opts.message ?? `capshelf: subagents/${name}`,
    mutate: async () => {
      for (const { source, raw } of pending) {
        const path = join(dataRepo, ...source.relPath.split("/"));
        await ensureDir(dirname(path), dataRepoScope(dataRepo));
        await atomicWriteFile(path, raw, dataRepoScope(dataRepo));
      }
    },
    // The candidate was generated from the project's files, so the committed
    // tree must equal what was read.
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
  // Check all canonical targets so a one-target share reports missing targets.
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
  // Assert the lock is writable before any data-repo mutation, or a legacy lock
  // would refuse after the fragment is already committed.
  const writableProjectLock = assertWritableLock(projectLock, "capshelf share");
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

  // Validate every source before writing any, so a bad target leaves the data
  // repo untouched.
  for (const { source, raw } of pending) {
    const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
    if (existsSync(canonicalPath)) {
      throw new PreconditionError(
        `fragment source already exists: ${source.relPath}`,
      );
    }
    parseFragmentSourceText(source, raw);
  }
  // The transaction owns these paths so a rejected commit removes them;
  // otherwise an untracked source remains and retry refuses it as existing.
  const sourceCommit = await commitDataRepoMutation({
    dataRepo,
    expectedHead: await headSha(dataRepo).catch(() => null),
    ownedRoots: pending.map(({ source }) => source.relPath),
    message: opts.message ?? `capshelf: ${kind}/${name}`,
    mutate: async () => {
      for (const { source, raw } of pending) {
        const canonicalPath = join(dataRepo, ...source.relPath.split("/"));
        await ensureDir(dirname(canonicalPath), dataRepoScope(dataRepo));
        await atomicWriteFile(canonicalPath, raw, dataRepoScope(dataRepo));
      }
    },
  });
  // Pending sources can be only a subset of the item's canonical paths, so they
  // are not compared with the whole committed item; the pin comes from the
  // committed tree.
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
  // Print the repeatable command, except for `--from` shares whose source file
  // may be gone.
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
 * Arguments go through `shellArg` because pick paths can hold spaces or `$`,
 * and the message is included since it is part of what the share did.
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
    // SAFETY: the one caller, `shareFragment`, refuses an empty candidate
    // list first, so the first candidate exists.
    const source = opts.candidates[0] as FragmentSource;
    const remainder = await loadOutputRemainder(opts, source);
    if (remainder === null) {
      throw new PreconditionError(
        `--pick requires ${outputLabelFor(opts.project, source)} to exist; nothing to extract from`,
      );
    }
    return [{ source, raw: extractFromRemainder(remainder, opts.picks) }];
  }

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

function parseShareScope(value: string | undefined): ShareScope | null {
  if (value === undefined) return null;
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
