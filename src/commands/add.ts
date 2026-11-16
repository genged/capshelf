import type { Command } from "commander";
import { join } from "node:path";
import { homeRelative } from "../paths";
import { loadProjectContext } from "../command-context";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  createDestructiveChangePlan,
  type DestructiveChange,
  type DestructiveChangePlan,
} from "../destructive-change";
import { planFragmentDestruction } from "../destructive-preflight";
import {
  saveManifest,
  addManifestName,
  manifestNamesForKind,
} from "../manifest";
import type { Manifest } from "../manifest";
import {
  assertWritableLock,
  createDataLockEntry,
  entryIdentity,
  dataKey,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { Lock } from "../lock";
import {
  assertNoDestinationCollisions,
  hashWidthOf,
  installedPinDigest,
  pinCurrentSource,
  shortIdentity,
  targetsUnderRoot,
} from "../pin";
import type { PinnedSource } from "../pin";
import {
  installedPreservedEntries,
  materializeLockEntry,
} from "../materialize";
import {
  ITEM_KINDS,
  allCanonicalItemRelPaths,
  installsAtSkillTarget,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isItemKind,
  listMasterItems,
} from "../master";
import type { MasterItem } from "../master";
import {
  METADATA_SIDECAR,
  captureCommittedItemNeeds,
  loadDataItemMetadata,
  loadCommittedItemNeeds,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata, ItemNeeds } from "../metadata";
import {
  NotFoundError,
  PreconditionError,
  ResultExitError,
  firstErrorLine,
} from "../errors";
import { targetDir } from "../sync";
import { findInstallConflict, installedPath, parseLockKey } from "../installed";
import { contentSourceFor, isGitTree } from "../item-source";
import { isSystemItemName } from "../bundled";
import { assertPathClean } from "../git";
import { GitReadMemo } from "../git-read-memo";
import { findMasterItemByRef, lockKeyForRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { loadRemotesLock } from "../remotes-lock";
import { assertSkillTargetFree } from "../skill-target";
import {
  addLocalConfigName,
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  localConfigNamesForKind,
  saveLocalConfig,
} from "../local-config";
import type { LocalConfig } from "../local-config";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  applyFragmentOutput,
  assertFragmentSourcesClean,
  fragmentContributionState,
  fragmentOutputPath,
  fragmentTargetPresenceInPaths,
  loadFragmentSourcesAtCommit,
  planFragmentOutput,
  presentSources,
} from "../fragments";
import {
  itemTargetCoverageAtCommit,
  itemTargetCoverageInPaths,
  printTargetCoverage,
  targetCoverageJson,
} from "../target-coverage";
import type { TargetCoverageReport } from "../target-coverage";
import { missingSourceCommitRepinGuidance } from "../status-format";
import type {
  FragmentApplyResult,
  FragmentOutputPlan,
  FragmentSource,
  FragmentTarget,
} from "../fragments";
import { isBundleRef, loadBundleStrict, memberRef } from "../bundles";
import { isRemoteSkillUrl } from "../remote-url";
import { addRemoteSkill } from "./add-remote";
import { loadPickCatalog } from "../pick-catalog";
import {
  pickItems,
  pickTerminalUnavailable,
  pickUnavailableMessage,
} from "../pick";
import type { PickUnavailableReason } from "../pick";
import type { Bundle } from "../bundles";
import {
  executeBundleInstall,
  planBundleInstall,
  planFailures,
  preflightBundleChecks,
} from "../bundle-install";
import type { BundlePlan, MemberPlan } from "../bundle-install";
import { formatDeclaredNeeds } from "../needs-format";
import { confirmPluginConsent } from "../plugin-consent";
import type { PluginConsentPoint } from "../plugin-consent";
import { itemPluginRunsAtCommit, pluginExtraFile } from "../plugin-runs";
import { holdsOnlyMountPoints } from "../mount-points";
import type { PluginRuns } from "../plugin-runs";
import {
  assertSubagentOutputAvailable,
  currentSubagentSources,
  materializeSubagent,
  validateCurrentSubagent,
} from "../subagents";

interface AddOptions {
  json?: boolean;
  local?: boolean;
  target?: string;
  yes?: boolean;
  as?: string;
  ref?: string;
  path?: string;
  list?: boolean;
}

const REMOTE_ONLY_FLAGS = ["--as", "--ref", "--path", "--list"] as const;

function assertNoRemoteOnlyFlags(opts: AddOptions, subject: string): void {
  for (const [flag, value] of [
    ["--as", opts.as],
    ["--ref", opts.ref],
    ["--path", opts.path],
    ["--list", opts.list],
  ] as const) {
    if (value !== undefined) {
      throw new PreconditionError(
        `add ${flag} applies to a repository URL only; ${subject}`,
      );
    }
  }
}

export interface AddContext {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  localConfig: LocalConfig | null;
  local: boolean;
  memo: GitReadMemo;
}

export interface InstallDataItemResult {
  sha: string;
  sourceCommit: string;
  dst: string;
  wasAlreadyInstalled: boolean;
  sources: FragmentSource[];
  targetCoverage: TargetCoverageReport | null;
  outputResults: FragmentApplyResult[];
  runtimeWarnings: RuntimeWarning[];
  missingRequires: string[];
  needs: ItemNeeds;
}

export function registerAdd(program: Command): void {
  program
    .command("add [item]")
    .description(
      "install an item (or expand a bundles/<name> bundle) from the data repo into the current project; with no item, pick from the shelf interactively",
    )
    .option("--local", "install as clone-local project state")
    .option("--yes", "authorize destructive collateral config changes")
    .option(
      "--target <target>",
      "target selection is not supported for add; subagents install all targets",
    )
    .option("--as <name>", "install the remote skill under a different name")
    .option("--ref <ref>", "branch or tag to install from (remote URL only)")
    .option(
      "--path <subpath>",
      "repository subdirectory to install (remote URL only)",
    )
    .option("--list", "list a repository's skills and exit (remote URL only)")
    .option("--json", "output JSON")
    .action(
      async (itemRef: string | undefined, opts: AddOptions, cmd: Command) => {
        if (itemRef === undefined) {
          // The no-argument branch returns before `addOne`'s checks, so repeat
          // this refusal or `--target` is silently ignored.
          if (opts.target) {
            throw new PreconditionError(
              "add --target is not supported; subagents and bundles install all available targets",
            );
          }
          assertNoRemoteOnlyFlags(
            opts,
            `it names none (${REMOTE_ONLY_FLAGS.join(", ")} need a URL)`,
          );
          // A script cannot answer a prompt; refusing beats printing a picker
          // to stderr and an empty result to stdout, which reads as an empty
          // shelf.
          if (opts.json) {
            throw new PreconditionError(
              "add --json requires an item; the interactive picker needs a terminal",
              {
                hint: "pass an item ref (capshelf add skills/<name>), or run capshelf add without --json to pick interactively",
              },
            );
          }
          const summary = await runInteractiveAdd({
            add: opts,
            cmd,
            message: "Select items to install",
          });
          if (summary.outcome === "unavailable") {
            throw new PreconditionError(
              `cannot pick interactively — ${pickUnavailableMessage(summary.reason)}`,
              {
                hint: "name the item instead: capshelf add <kind>/<name>. Run capshelf ls to see the shelf.",
              },
            );
          }
          if (summary.outcome === "installed" && summary.failed.length > 0) {
            throw new ResultExitError(3);
          }
          return;
        }
        await addOne(itemRef, opts, cmd);
      },
    );
}

async function addOne(
  itemRef: string,
  opts: AddOptions,
  cmd: Command,
): Promise<void> {
  // Check bundle refs before `parseItemRef`, which rejects "bundles" as an item
  // kind.
  const bundleName = isBundleRef(itemRef);
  if (bundleName !== null) {
    if (opts.target) {
      throw new PreconditionError(
        "add --target is not supported; subagents and bundles install all available targets",
      );
    }
    assertNoRemoteOnlyFlags(opts, `${itemRef} names a bundle`);
    await addBundle(bundleName, opts, cmd);
    return;
  }

  // Classify URLs before the ref parser, which reserves ":" and would refuse
  // every URL.
  if (isRemoteSkillUrl(itemRef)) {
    await addRemoteSkill(itemRef, opts, cmd);
    return;
  }

  assertNoRemoteOnlyFlags(opts, `${itemRef} names a shelf item`);

  const shorthand = nonKindRefRefusal(itemRef);
  if (shorthand) throw shorthand;

  const ref = parseItemRef(itemRef);
  if (opts.target) {
    throw new PreconditionError(
      "add --target is not supported; subagents install all available targets",
    );
  }
  if (isSystemItemName(ref.name)) {
    throw new PreconditionError(systemItemAddRefusal(ref.name));
  }

  const ctx = await loadAddContext(opts, cmd);
  const selectedLock = ctx.local ? ctx.localLock : ctx.projectLock;
  const otherLock = ctx.local ? ctx.projectLock : ctx.localLock;
  const selectedKey = lockKeyForRef(selectedLock, ref, "data");
  const otherKey = lockKeyForRef(otherLock, ref, "data");
  if (otherKey) {
    const parsed = parseLockKey(otherKey);
    const otherScope = ctx.local ? "project" : "local";
    throw new PreconditionError(
      `${parsed.kind}/${parsed.name} is already owned by ${otherScope} scope; remove one owner before adding another`,
    );
  }
  if (selectedKey && trackedInSelectedManifest(ctx, selectedKey)) {
    await printAlreadyInstalled(ctx, selectedKey, opts.json === true);
    return;
  }
  const item = await findMasterItemByRef(ctx.dataRepo, ref);
  if (!item) {
    throw new NotFoundError(
      `not found in data repo (${ctx.dataRepo}): ${itemRef}`,
    );
  }

  const consent = await approveAddPin(ctx, item, {
    json: opts.json === true,
    yes: opts.yes === true,
  });
  if (!consent.proceed) return;

  const result = await installDataItem(ctx, item, {
    memo: ctx.memo,
    ...(consent.pin && { pin: consent.pin }),
    ...(consent.needs && { needs: consent.needs }),
  });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          kind: item.kind,
          name: item.name,
          scope: ctx.local ? "local" : "project",
          sha: result.sha,
          sourceCommit: result.sourceCommit,
          needs: result.needs,
          dst: result.dst,
          wasAlreadyInstalled: result.wasAlreadyInstalled,
          ...(result.sources.length > 0 && {
            sources: fragmentSourcesJson(ctx.project, result),
          }),
          ...(result.targetCoverage &&
            targetCoverageJson(result.targetCoverage, ctx.project)),
          ...(result.runtimeWarnings.length > 0 && {
            runtimeWarnings: result.runtimeWarnings,
          }),
          ...(result.missingRequires.length > 0 && {
            missingRequires: result.missingRequires,
          }),
        },
        null,
        2,
      ),
    );
    printMissingRequires(`${item.kind}/${item.name}`, result.missingRequires);
    return;
  }
  const scope = ctx.local ? "local" : "project";
  console.log(
    `✓ added ${scope}/data/${item.kind}/${item.name} @ ${shortIdentity(result.sha)}`,
  );
  console.log(`  source commit: ${result.sourceCommit}`);
  if (result.targetCoverage) {
    printTargetCoverage(result.targetCoverage, itemRefLabel(item), {
      presentWord: "written",
      tracked: true,
    });
  } else {
    console.log(`  ${result.dst}`);
  }
  if (item.kind === "plugins") {
    // A switch from `skills/<n>` changes the name Claude Code uses and capshelf
    // cannot see it across commands, so every plugin add prints the name.
    console.log(
      `  Claude Code loads it as ${item.name}@skills-dir in a trusted workspace`,
    );
  }
  printDeclaredNeeds(result.needs);
  printRuntimeWarnings(result.runtimeWarnings);
  printMissingRequires(`${item.kind}/${item.name}`, result.missingRequires);
}

/**
 * `init` passes an already-resolved `dataRepo` because commander binds a
 * `--data` URL before the subcommand to the root command, and resolving it
 * again would treat the URL as a path.
 */
async function loadAddContext(
  opts: AddOptions,
  cmd: Command,
  dataRepo?: string,
  memo = new GitReadMemo(),
): Promise<AddContext> {
  const base = await loadProjectContext({
    cmd,
    dataRepo: dataRepo === undefined,
  });
  const localConfig = await loadLocalConfig(base.project);
  return {
    ...base,
    dataRepo: dataRepo ?? base.dataRepo!,
    localConfig,
    local: opts.local ?? false,
    memo,
  };
}

function trackedInSelectedManifest(ctx: AddContext, key: string): boolean {
  const parsed = parseLockKey(key);
  return ctx.local
    ? ctx.localConfig !== null &&
        localConfigNamesForKind(ctx.localConfig, parsed.kind).includes(
          parsed.name,
        )
    : manifestNamesForKind(ctx.manifest, parsed.kind).includes(parsed.name);
}

async function printAlreadyInstalled(
  ctx: AddContext,
  key: string,
  json: boolean,
): Promise<void> {
  const parsed = parseLockKey(key);
  const lock = ctx.local ? ctx.localLock : ctx.projectLock;
  const entry = lock.items[key]!;
  const scope = ctx.local ? "local" : "project";
  const localFlag = ctx.local ? " --local" : "";
  const guidance = [
    `Review installed changes: capshelf status ${parsed.kind}/${parsed.name}${localFlag} --diff`,
    `Select newer upstream content: capshelf update ${parsed.kind}/${parsed.name}${localFlag}`,
    `Restore the selected lock: capshelf apply ${parsed.kind}/${parsed.name}${localFlag}`,
    `Discard installed changes: capshelf revert ${parsed.kind}/${parsed.name}${localFlag}`,
    `Publish installed changes: capshelf promote ${parsed.kind}/${parsed.name}${localFlag}`,
    ...(isCopyDirectoryItemKind(parsed.kind)
      ? [
          `Keep installed divergence: capshelf keep-local ${parsed.kind}/${parsed.name}${localFlag} --reason <why>`,
        ]
      : []),
  ];
  const runtimeWarnings = runtimeWarningsForItem(
    ctx.project,
    parsed.kind,
    parsed.name,
  );
  // A locked sourceCommit can be unreachable (rewritten history, unfetched
  // clone), so coverage degrades to `unknown` instead of crashing a re-run of
  // `add`.
  const locked = contentSourceFor({
    entry,
    kind: parsed.kind,
    name: parsed.name,
    repo: ctx.dataRepo,
  });
  const targetCoverage = isGitTree(locked)
    ? await itemTargetCoverageAtCommit(
        ctx.project,
        locked.repo,
        parsed.kind,
        parsed.name,
        locked.commit,
      )
    : null;
  const missingRequires = isGitTree(locked)
    ? (
        await loadCommittedItemNeeds(
          ctx.dataRepo,
          { kind: parsed.kind, name: parsed.name },
          locked.commit,
        )
      ).requires.filter(
        (required) =>
          ctx.projectLock.items[`data/${required}`] === undefined &&
          ctx.projectLock.items[`system/${required}`] === undefined &&
          ctx.localLock.items[`data/${required}`] === undefined &&
          ctx.localLock.items[`system/${required}`] === undefined,
      )
    : [];
  if (json) {
    console.log(
      JSON.stringify(
        {
          kind: parsed.kind,
          name: parsed.name,
          scope,
          action: "already-installed",
          sha: entryIdentity(entry),
          ...(entry.source === "data" && {
            sourceCommit: entry.sourceCommit,
            needs: entry.needs ?? { network: [], env: [], bin: [] },
          }),
          wasAlreadyInstalled: true,
          guidance,
          ...(targetCoverage &&
            targetCoverageJson(targetCoverage, ctx.project)),
          ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
          ...(missingRequires.length > 0 && { missingRequires }),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(
    `= already installed ${scope}/data/${parsed.kind}/${parsed.name} @ ${shortIdentity(entryIdentity(entry))}`,
  );
  if (targetCoverage) {
    printTargetCoverage(targetCoverage, `${parsed.kind}/${parsed.name}`, {
      presentWord: "present",
      absentScope: "locked",
      tracked: true,
      // Only offer the re-pin guidance for the state it fixes; it would not
      // help an unreadable object database.
      unknownGuidance:
        targetCoverage.reason === "locked commit unreachable"
          ? missingSourceCommitRepinGuidance(parsed.kind, parsed.name, "    ")
          : [],
    });
  }
  for (const line of guidance) console.log(`  ${line}`);
  printRuntimeWarnings(runtimeWarnings);
  printMissingRequires(`${parsed.kind}/${parsed.name}`, missingRequires);
}

/**
 * The pin travels to the install so the consented tree is the written tree;
 * re-pinning after revalidation could add a target the consent gate never saw.
 */
interface FragmentAddPreflight {
  plan: DestructiveChangePlan;
  pin: PinnedSource | null;
}

async function planStandaloneFragmentAdd(
  ctx: AddContext,
  item: MasterItem,
): Promise<FragmentAddPreflight> {
  if (!isFragmentItemKind(item.kind)) {
    return { plan: createDestructiveChangePlan([]), pin: null };
  }
  if (ctx.local) {
    assertLocalScopeSupported(item.kind, item.name, "add --local");
  }
  await assertFragmentSourcesClean(ctx.dataRepo, item.kind, item.name);
  const [pin, snapshot] = await Promise.all([
    pinCurrentSource(ctx.dataRepo, item.kind, item.name, { memo: ctx.memo }),
    captureCommittedItemNeeds(ctx.dataRepo, item, { memo: ctx.memo }),
  ]);
  const nextManifest = structuredClone(ctx.manifest);
  addToManifest(nextManifest, item);
  const nextLock = assertWritableLock(
    structuredClone(ctx.projectLock),
    "capshelf add",
  );
  const nextEntry = createDataLockEntry({ pin, ...snapshot });
  nextLock.items[dataKey(item.kind, item.name)] = nextEntry;
  // Read the pin, not the worktree: a dirty deletion is invisible to the
  // cleanliness check, so a worktree read would skip the consent gate for TOML
  // comment loss. Use the pin's own listing so the gate covers exactly what
  // `installDataItem` writes.
  await loadFragmentSourcesAtCommit({
    dataRepo: ctx.dataRepo,
    kind: item.kind,
    name: item.name,
    commit: pin.sourceCommit,
    manifest: ctx.manifest,
    memo: ctx.memo,
  });
  const targets = [
    ...new Set(
      presentSources(
        fragmentTargetPresenceInPaths(
          item.kind,
          item.name,
          pin.entries.map((entry) => entry.repoRelPath),
        ),
      ).map((source) => source.target),
    ),
  ];
  const plans: FragmentOutputPlan[] = [];
  const contributionStates = new Map<
    FragmentTarget,
    Awaited<ReturnType<typeof fragmentContributionState>>
  >();
  const reviewCommands = new Map<FragmentTarget, string>();
  for (const target of [...new Set(targets)].sort()) {
    plans.push(
      await planFragmentOutput({
        project: ctx.project,
        dataRepo: ctx.dataRepo,
        manifest: nextManifest,
        oldManifest: ctx.manifest,
        nextManifest,
        oldLock: ctx.projectLock,
        nextLock,
        target,
        memo: ctx.memo,
      }),
    );
    const contributionState = await fragmentContributionState(
      ctx.project,
      ctx.dataRepo,
      ctx.manifest,
      ctx.projectLock,
      target,
      ctx.memo,
    );
    contributionStates.set(target, contributionState);
    // Offer `status --diff` only when contribution is drifted: first-add and
    // comment-only loss show nothing there, so the named command would
    // contradict the prompt.
    if (contributionState === "drifted") {
      reviewCommands.set(target, "capshelf status --diff");
    }
  }
  const destruction = planFragmentDestruction({
    project: ctx.project,
    plans,
    contributionStates,
    reviewCommands,
  });
  return {
    plan: createDestructiveChangePlan(destruction.changes, [
      ...destruction.snapshotParts,
      `add-source:${item.kind}/${item.name}:${pin.sourcePinDigest}:${pin.sourceCommit}`,
    ]),
    pin,
  };
}

export interface InstallDataItemOptions {
  memo?: GitReadMemo;
  /**
   * Bundle executor disables this: bundle preflight already ran the conflict
   * and requires checks across installed items and siblings.
   */
  enforceRelations?: boolean;
  /** Reusing the preflight pin makes the approved tree the written tree. */
  pin?: PinnedSource;
  /**
   * Needs read with `pin`, so the lock entry pairs files and needs from one
   * read rather than a later HEAD.
   */
  needs?: NeedsSnapshot;
}

type NeedsSnapshot = Awaited<ReturnType<typeof captureCommittedItemNeeds>>;

/**
 * Persists manifest and lock before returning so a mid-bundle failure leaves a
 * consistent prefix; callers skip installed items, so it has no skip guard.
 */
export async function installDataItem(
  ctx: AddContext,
  item: MasterItem,
  opts: InstallDataItemOptions = {},
): Promise<InstallDataItemResult> {
  const memo = opts.memo ?? new GitReadMemo();
  const { project, dataRepo, manifest, projectLock, localLock, localConfig } =
    ctx;
  const lock = ctx.local ? localLock : projectLock;
  const oldLock = structuredClone(lock);

  if (ctx.local) {
    assertLocalScopeSupported(item.kind, item.name, "add --local");
  }
  if (
    !isCopyDirectoryItemKind(item.kind) &&
    !isCopyTargetFileItemKind(item.kind) &&
    !isFragmentItemKind(item.kind)
  ) {
    throw new Error(`no add strategy for ${item.kind}/${item.name}`);
  }

  // An authoring check: a dirty path means the commit capshelf pins is stale
  // against what the author sees.
  if (isFragmentItemKind(item.kind)) {
    await assertFragmentSourcesClean(dataRepo, item.kind, item.name);
  } else if (item.kind === "subagents") {
    for (const relPath of allCanonicalItemRelPaths(item.kind, item.name)) {
      await assertPathClean(dataRepo, relPath);
    }
    for (const warning of await validateCurrentSubagent(
      project,
      dataRepo,
      item.name,
    )) {
      console.error(`⚠ ${warning}`);
    }
  } else if (isCopyDirectoryItemKind(item.kind)) {
    await assertPathClean(dataRepo, item.repoRelPath);
  } else {
    throw new Error(`no source-cleanliness strategy for ${item.kind}`);
  }

  const key = dataKey(item.kind, item.name);
  const otherLock = ctx.local ? projectLock : localLock;
  if (otherLock.items[key] !== undefined) {
    const otherScope = ctx.local ? "project" : "local";
    throw new PreconditionError(
      `${item.kind}/${item.name} is already owned by ${otherScope} scope; remove one owner before adding another`,
    );
  }
  const alreadyInManifest = ctx.local
    ? localConfig !== null &&
      localConfigNamesForKind(localConfig, item.kind).includes(item.name)
    : manifestNamesForKind(manifest, item.kind).includes(item.name);
  const alreadyInLock = lock.items[key] !== undefined;
  // A worktree read is safe here: cleanliness covers the static canonical
  // paths, so a dirty or deleted source refused earlier and worktree and pin
  // cannot disagree; it only feeds `dst`.
  const subagentSources =
    item.kind === "subagents"
      ? await currentSubagentSources(project, dataRepo, item.name)
      : [];

  if (installsAtSkillTarget(item.kind)) {
    const external = await findSkillsShSkill(project, item.name);
    if (external) {
      throw new PreconditionError(
        `not installing ${item.kind}/${item.name} — ${skillsShConflictMessage(external)}`,
      );
    }
    // Folder-level check before `findInstallConflict`, which only sees path
    // existence: a `plugins/<n>` add over an installed `skills/<n>` would
    // silently adopt its folder.
    await assertSkillTargetFree(
      project,
      item.kind,
      item.name,
      {
        project: projectLock,
        local: localLock,
        remotes: await loadRemotesLock(project),
      },
      null,
    );
  }

  const conflict =
    isFragmentItemKind(item.kind) || item.kind === "subagents"
      ? null
      : findInstallConflict(
          project,
          item.kind,
          item.name,
          manifest.installMode,
        );
  if (!alreadyInLock && item.kind === "subagents") {
    await assertSubagentOutputAvailable(project, dataRepo, item.name);
  }
  if (ctx.local) {
    await assertLocalInstallPathsUntracked(project, item.kind, item.name);
  }

  const missingRequires =
    opts.enforceRelations === false
      ? []
      : await enforceItemRelations(dataRepo, item, projectLock, localLock);

  // Pin once from the committed tree so refusals (filter driver, symlink,
  // gitlink) happen before any manifest or lock mutation.
  const pin =
    opts.pin ??
    (await pinCurrentSource(dataRepo, item.kind, item.name, { memo }));
  // Derive fragment targets from the pinned tree, as `apply` derives them from
  // the lock, so `add` and `apply` agree on one lock entry.
  const pinnedPaths = pin.entries.map((entry) => entry.repoRelPath);
  const sources = isFragmentItemKind(item.kind)
    ? presentSources(
        fragmentTargetPresenceInPaths(item.kind, item.name, pinnedPaths),
      )
    : [];
  const targetCoverage = itemTargetCoverageInPaths(
    project,
    item.kind,
    item.name,
    pinnedPaths,
  );
  if (isFragmentItemKind(item.kind) && sources.length === 0) {
    throw new PreconditionError(
      `${item.kind}/${item.name} has no canonical source files at ${pin.sourceCommit}`,
    );
  }
  // A supplied pin was validated during planning; validate pins created here
  // before mutation.
  if (opts.pin === undefined && isFragmentItemKind(item.kind)) {
    await loadFragmentSourcesAtCommit({
      dataRepo,
      kind: item.kind,
      name: item.name,
      commit: pin.sourceCommit,
      manifest,
      memo,
    });
  }
  const dst = isFragmentItemKind(item.kind)
    ? fragmentOutputPath(project, sources[0]!.target)
    : item.kind === "subagents"
      ? subagentSources[0]!.outputPath
      : targetDir(project, item, manifest.installMode);
  if (isCopyDirectoryItemKind(item.kind)) {
    await assertNoDestinationCollisions(
      `${item.kind}/${item.name}`,
      dst,
      pin.entries.map((entry) => entry.path),
    );
  }
  const snapshot =
    opts.needs ?? (await captureCommittedItemNeeds(dataRepo, item, { memo }));
  let adoptMatchingInstall = false;
  if (!alreadyInLock && conflict) {
    if (isCopyDirectoryItemKind(item.kind)) {
      // A folder holding only a mounted volume is what `rm` leaves; a mount
      // point cannot be deleted, so treat it as empty.
      adoptMatchingInstall =
        (await matchesPinnedInstall(ctx, item, conflict, pin)) ||
        (conflict ===
          installedPath(
            ctx.project,
            item.kind,
            item.name,
            ctx.manifest.installMode,
          ) &&
          (await holdsOnlyMountPoints(conflict)));
    }
    if (!adoptMatchingInstall) {
      throw new PreconditionError(
        `not installing ${item.kind}/${item.name} — target already exists but is not managed by capshelf and does not exactly match the commit selected for recovery\n` +
          `  existing path: ${conflict}\n` +
          `  expected commit: ${pin.sourceCommit}\n` +
          "  preserve or remove the conflicting target, then retry; capshelf will not adopt mismatched content",
      );
    }
  }

  if (ctx.local) {
    if (!localConfig) {
      throw new PreconditionError(
        "no local manifest exists; run capshelf init or capshelf set-data first",
      );
    }
    addLocalConfigName(localConfig, item.kind, item.name);
  } else {
    addToManifest(manifest, item);
  }
  const writableLock = assertWritableLock(lock, "capshelf add");
  const previousEntry = writableLock.items[key];
  writableLock.items[key] = createDataLockEntry({
    pin,
    ...snapshot,
  });

  const outputResults: FragmentApplyResult[] = [];
  if (isFragmentItemKind(item.kind)) {
    for (const target of new Set(sources.map((source) => source.target))) {
      outputResults.push(
        await applyFragmentOutput({
          project,
          dataRepo,
          manifest,
          oldLock,
          nextLock: writableLock,
          target,
          memo,
        }),
      );
    }
  } else if (isCopyDirectoryItemKind(item.kind)) {
    // Materialize from the commit's blobs, as `apply` does, so the two routes
    // read the same objects and cannot disagree.
    const entry = writableLock.items[key]!;
    await materializeLockEntry({
      project,
      source: contentSourceFor({
        entry,
        kind: item.kind,
        name: item.name,
        repo: dataRepo,
      }),
      manifest,
      kind: item.kind,
      name: item.name,
      key,
      entry,
      scope: ctx.local ? "local" : "project",
    });
  } else if (item.kind === "subagents") {
    const entry = writableLock.items[key];
    if (entry?.source !== "data")
      throw new Error(`expected data lock for ${key}`);
    const result = await materializeSubagent({
      project,
      dataRepo,
      name: item.name,
      entry,
      ...(previousEntry?.source === "data" && { previousEntry }),
      memo,
    });
    for (const warning of result.warnings) console.error(`⚠ ${warning}`);
  } else {
    throw new Error(`no materialization strategy for ${item.kind}`);
  }
  const runtimeWarnings = runtimeWarningsForItem(project, item.kind, item.name);

  if (ctx.local) {
    if (!localConfig) throw new Error("expected local manifest");
    await ensureLocalExcludes(project, item.kind, item.name);
    await saveLocalConfig(project, localConfig);
    await saveLocalLock(project, writableLock);
  } else {
    await saveManifest(project, manifest);
    await saveLock(project, writableLock);
  }

  return {
    sha: pin.sourcePinDigest,
    sourceCommit: pin.sourceCommit,
    dst,
    wasAlreadyInstalled: alreadyInManifest && alreadyInLock,
    sources,
    targetCoverage,
    outputResults,
    runtimeWarnings,
    missingRequires,
    needs: snapshot.needs,
  };
}

/**
 * Adopt an unmanaged target only if it matches the pin; comparing digests of
 * paths, modes, and blob IDs avoids reading the pinned blob contents.
 */
async function matchesPinnedInstall(
  ctx: AddContext,
  item: MasterItem,
  conflict: string,
  pin: PinnedSource,
): Promise<boolean> {
  if (!isCopyDirectoryItemKind(item.kind)) return false;
  const canonicalPath = installedPath(
    ctx.project,
    item.kind,
    item.name,
    ctx.manifest.installMode,
  );
  if (conflict !== canonicalPath) return false;
  const digest = await installedPinDigest(
    targetsUnderRoot(canonicalPath, pin.entries),
    hashWidthOf(pin.entries),
  );
  return digest === pin.sourcePinDigest;
}

async function addBundle(
  name: string,
  opts: AddOptions,
  cmd: Command,
  dataRepo?: string,
  memo?: GitReadMemo,
): Promise<void> {
  const ctx = await loadAddContext(opts, cmd, dataRepo, memo);
  const bundle = await loadBundleStrict(ctx.dataRepo, name);
  for (const warning of new Set(bundle.warnings)) {
    console.error(`⚠ ${warning}`);
  }
  const scope = ctx.local ? ("local" as const) : ("project" as const);
  if (ctx.local && !ctx.localConfig) {
    throw new Error(
      "no local manifest exists; run capshelf init or capshelf set-data first",
    );
  }

  const masterItems = await listMasterItems(ctx.dataRepo);
  const masterByRef = new Map(
    masterItems.map((item) => [`${item.kind}/${item.name}`, item]),
  );
  const metadataByRef = await loadRelationMetadata(
    bundle,
    masterByRef,
    ctx.projectLock,
    ctx.localLock,
  );

  const plan = planBundleInstall({
    bundle,
    masterItems,
    projectLock: ctx.projectLock,
    localLock: ctx.localLock,
    scope,
    metadataByRef,
  });
  await preflightBundleChecks(plan, {
    project: ctx.project,
    dataRepo: ctx.dataRepo,
    manifest: ctx.manifest,
    lock: ctx.local ? ctx.localLock : ctx.projectLock,
    skillTargetLocks: {
      project: ctx.projectLock,
      local: ctx.localLock,
      remotes: await loadRemotesLock(ctx.project),
    },
    masterByRef,
    memo: ctx.memo,
  });

  const failures = planFailures(plan);
  if (failures.length > 0) {
    if (opts.json) {
      printBundleJson(bundle, plan, ctx, new Map());
    } else {
      printBundleRefusal(bundle, plan, failures, ctx);
    }
    throw new ResultExitError(3);
  }

  // Skills with a plugin manifest need plugin consent too. Keep every
  // inspected pin, even when no prompt is needed, because a later commit
  // could add a manifest and hooks.
  const inspectedPins = new Map<
    string,
    { pin: PinnedSource; needs: NeedsSnapshot }
  >();
  const pluginPoints: PluginConsentPoint[] = [];
  for (const member of plan.members) {
    if (member.status !== "install") continue;
    if (member.kind !== "plugins" && member.kind !== "skills") continue;
    const pin = await pinCurrentSource(ctx.dataRepo, member.kind, member.name, {
      memo: ctx.memo,
    });
    inspectedPins.set(member.ref, {
      pin,
      needs: await captureCommittedItemNeeds(ctx.dataRepo, member, {
        memo: ctx.memo,
      }),
    });
    const runs = await addPluginRuns(ctx, member.kind, member.name, pin);
    if (runs === null) continue;
    pluginPoints.push(...shelfPluginAddPoints(member.ref, runs, ctx.local));
  }
  if (
    !(await confirmPluginConsent(pluginPoints, {
      json: opts.json === true,
      yes: opts.yes === true,
    }))
  ) {
    return;
  }

  // Bundles are the recommended entry point, so destructive fragment changes
  // must be gated here too, not only for `add settings/extra`.
  const planBundleDestruction = async (): Promise<{
    plan: DestructiveChangePlan;
    pins: Map<string, PinnedSource>;
  }> => {
    const changes: DestructiveChange[] = [];
    const snapshotParts: string[] = [];
    const pins = new Map<string, PinnedSource>();
    for (const member of plan.members) {
      if (member.status !== "install") continue;
      if (!isFragmentItemKind(member.kind)) continue;
      const item = masterByRef.get(member.ref);
      if (!item) continue;
      const memberPlan = await planStandaloneFragmentAdd(ctx, item);
      changes.push(...memberPlan.plan.changes);
      snapshotParts.push(memberPlan.plan.snapshot);
      if (memberPlan.pin) pins.set(member.ref, memberPlan.pin);
    }
    return { plan: createDestructiveChangePlan(changes, snapshotParts), pins };
  };
  const destructivePlan = await planBundleDestruction();
  if (
    !(await confirmDestructiveChanges(destructivePlan.plan, {
      operation: "Add",
      json: opts.json === true,
      yes: opts.yes === true,
      dryRun: false,
      rerunCommand: `capshelf add bundles/${bundle.name}${ctx.local ? " --local" : ""} --yes`,
    }))
  ) {
    return;
  }
  const revalidated = await planBundleDestruction();
  assertDestructivePlanUnchanged(destructivePlan.plan, revalidated.plan);

  const results = await executeBundleInstall(plan, {
    projectLock: ctx.projectLock,
    localLock: ctx.localLock,
    scope,
    installItem: (member: MemberPlan) => {
      const item = masterByRef.get(member.ref);
      if (!item) throw new Error(`expected master item for ${member.ref}`);
      // Reuse approved fragment pins and inspected skill/plugin pins so later
      // members cannot install content outside the shared consent checks.
      const inspected = inspectedPins.get(member.ref);
      const approved = revalidated.pins.get(member.ref) ?? inspected?.pin;
      return installDataItem(ctx, item, {
        enforceRelations: false,
        memo: ctx.memo,
        ...(approved && { pin: approved }),
        ...(inspected && { needs: inspected.needs }),
      });
    },
  });

  if (opts.json) {
    printBundleJson(bundle, plan, ctx, results);
  } else {
    printBundleSummary(bundle, plan, results);
  }
  for (const [ref, missing] of plan.missingRequiresByMember) {
    printMissingRequires(ref, missing);
  }
}

export type InteractiveAddSummary =
  | { outcome: "unavailable"; reason: PickUnavailableReason }
  | { outcome: "cancelled" }
  | { outcome: "nothing-selected" }
  | {
      outcome: "installed";
      added: string[];
      alreadyInstalled: string[];
      failed: string[];
    };

/**
 * Best effort unlike `add bundles/<name>`: a picker selection is independent
 * choices, so one failure must not discard the rest. Returns a summary because
 * `init` exits 0 even when items fail, since the project is initialized.
 */
export async function runInteractiveAdd(request: {
  add: AddOptions;
  cmd: Command;
  message: string;
  dataRepo?: string;
}): Promise<InteractiveAddSummary> {
  const { add: opts, cmd, message, dataRepo } = request;
  // Check the terminal first: reading the shelf can refuse for reasons that
  // belong to `ls`.
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  let ctx = await loadAddContext(opts, cmd, dataRepo);
  // Pin the repo: a `capshelf data bind` in another terminal during the picker
  // would otherwise install chosen refs from a different shelf; reloads go
  // through `reload` so the pin can't be forgotten.
  const boundRepo = ctx.dataRepo;
  const memo = ctx.memo;
  const reload = (): Promise<AddContext> =>
    loadAddContext(opts, cmd, boundRepo, memo);
  const catalog = await loadPickCatalog({
    dataRepo: boundRepo,
    projectLock: ctx.projectLock,
    localLock: ctx.localLock,
  });
  for (const warning of catalog.warnings) console.error(`⚠ ${warning}`);

  const picked = await pickItems({ rows: catalog.rows, message });
  if (picked.kind === "unavailable") {
    return { outcome: "unavailable", reason: picked.reason };
  }
  if (picked.kind === "cancelled") return { outcome: "cancelled" };
  if (picked.refs.length === 0) return { outcome: "nothing-selected" };

  // Reload before writing: the picker can block indefinitely, and saving from
  // the pre-prompt snapshot would drop entries other capshelf runs added
  // meanwhile. This narrows the window but isn't atomic.
  ctx = await reload();

  const added: string[] = [];
  const alreadyInstalled: string[] = [];
  const failed: string[] = [];

  // Bundles go first through the all-or-nothing path; their members may satisfy
  // a picked item's `requires`.
  const bundleNames = picked.refs
    .map((ref) => isBundleRef(ref))
    .filter((name): name is string => name !== null);
  for (const name of bundleNames) {
    try {
      await addBundle(name, opts, cmd, boundRepo, memo);
      added.push(`bundles/${name}`);
    } catch (error) {
      // `addBundle` prints its own refusal before throwing ResultExitError, so
      // a code-only error needs no second message here.
      failed.push(`bundles/${name}`);
      const detail = errorDetail(error);
      if (detail) console.error(`✗ bundles/${name} — ${detail}`);
    }
  }

  // Reload: each `addBundle` saved its own lock, and writing from the older
  // context would drop their entries.
  if (bundleNames.length > 0) ctx = await reload();

  const itemRefs = picked.refs.filter((ref) => isBundleRef(ref) === null);
  for (const itemRef of itemRefs) {
    try {
      const ref = parseItemRef(itemRef);
      // A bundle installed above may already have covered this item. The
      // single-item installer has no skip guard by design, so the check
      // belongs here.
      if (
        lockKeyForRef(ctx.projectLock, ref, "data") ??
        lockKeyForRef(ctx.localLock, ref, "data")
      ) {
        alreadyInstalled.push(itemRef);
        console.log(`= ${itemRef.padEnd(33)} already installed`);
        continue;
      }
      // Both entry points into `installDataItem` must refuse system names, or
      // `data/skills/capshelf` and `system/skills/capshelf` would own one
      // destination.
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(systemItemAddRefusal(ref.name));
      }
      const item = await findMasterItemByRef(boundRepo, ref);
      if (!item) {
        throw new NotFoundError(
          `not found in data repo (${homeRelative(boundRepo)}): ${itemRef}`,
        );
      }

      const consent = await approveAddPin(ctx, item, {
        json: false,
        yes: opts.yes === true,
      });
      if (!consent.proceed) {
        failed.push(itemRef);
        continue;
      }

      const result = await installDataItem(ctx, item, {
        memo: ctx.memo,
        ...(consent.pin && { pin: consent.pin }),
        ...(consent.needs && { needs: consent.needs }),
      });
      added.push(itemRef);
      console.log(`+ ${itemRef.padEnd(33)} @ ${shortIdentity(result.sha)}`);
      // `add` is documented to report which runtimes it covered; a coverage gap
      // is not a runtime warning, so the later call can't replace this.
      if (result.targetCoverage) {
        printTargetCoverage(result.targetCoverage, itemRef, {
          presentWord: "written",
          tracked: true,
        });
      }
      printDeclaredNeeds(result.needs, "    ");
      printRuntimeWarnings(result.runtimeWarnings, "    ");
      printMissingRequires(itemRef, result.missingRequires);
    } catch (error) {
      failed.push(itemRef);
      console.error(`✗ ${itemRef.padEnd(33)} ${errorDetail(error)}`);
      // Reload: `installDataItem` records the manifest and lock entry before
      // materializing, so a failure would leave a phantom entry that the next
      // save persists.
      ctx = await reload();
    }
  }

  printInteractiveSummary({ added, alreadyInstalled, failed }, ctx.local);
  return { outcome: "installed", added, alreadyInstalled, failed };
}

/**
 * `owner/repo` looks like `kind/name`, so one refusal covers both typo and
 * GitHub shorthand; `add` uses exit 3 for bad arguments, unlike the parser's
 * exit 1.
 */
function nonKindRefRefusal(itemRef: string): PreconditionError | null {
  const parts = itemRef.trim().split("/");
  if (parts.length !== 2) return null;
  const [kind, name] = parts;
  if (!kind || !name || isItemKind(kind)) return null;
  return new PreconditionError(
    `"${kind}" is not an item kind (supported: ${ITEM_KINDS.join(", ")})`,
    {
      hint:
        "owner/repo shorthand is ambiguous with kind/name here\n" +
        `  pass the full URL: capshelf add https://github.com/${kind}/${name}\n` +
        `  or name a shelf item instead: capshelf add skills/${name}`,
    },
  );
}

function systemItemAddRefusal(name: string): string {
  return `"${name}" is a system item — managed by the CLI, not addable from a data repo. It is installed automatically by 'capshelf init'.`;
}

/**
 * Includes ignored local files kept when adopting an existing folder, since a
 * kept manifest or hook file runs as part of the plugin.
 */
async function addPluginRuns(
  ctx: Awaited<ReturnType<typeof loadAddContext>>,
  kind: "plugins" | "skills",
  name: string,
  pin: PinnedSource,
): Promise<PluginRuns | null> {
  const extras = (
    await installedPreservedEntries({
      project: ctx.project,
      kind,
      name,
      scope: ctx.local ? "local" : "project",
      managedPaths: new Set(pin.entries.map((entry) => entry.path)),
    })
  ).map(pluginExtraFile);
  return await itemPluginRunsAtCommit(ctx.dataRepo, kind, pin.entries, extras);
}

/**
 * The approved pin is passed to `installDataItem` so the tree the user
 * consented to is the tree written; skills with a plugin manifest are gated
 * because Claude Code loads them as plugins.
 */
async function approveAddPin(
  ctx: Awaited<ReturnType<typeof loadAddContext>>,
  item: MasterItem,
  opts: { json: boolean; yes: boolean },
): Promise<{
  proceed: boolean;
  pin: PinnedSource | null;
  needs?: NeedsSnapshot;
}> {
  if (item.kind === "plugins" || item.kind === "skills") {
    const pin = await pinCurrentSource(ctx.dataRepo, item.kind, item.name, {
      memo: ctx.memo,
    });
    const needs = await captureCommittedItemNeeds(ctx.dataRepo, item, {
      memo: ctx.memo,
    });
    const runs = await addPluginRuns(ctx, item.kind, item.name, pin);
    if (runs === null) return { proceed: true, pin, needs };
    const points = shelfPluginAddPoints(
      `${item.kind}/${item.name}`,
      runs,
      ctx.local,
    );
    return { proceed: await confirmPluginConsent(points, opts), pin, needs };
  }
  if (!isFragmentItemKind(item.kind)) return { proceed: true, pin: null };
  const preflight = await planStandaloneFragmentAdd(ctx, item);
  if (
    !(await confirmDestructiveChanges(preflight.plan, {
      operation: "Add",
      json: opts.json,
      yes: opts.yes,
      dryRun: false,
      rerunCommand: `capshelf add ${item.kind}/${item.name}${ctx.local ? " --local" : ""} --yes`,
    }))
  ) {
    return { proceed: false, pin: null };
  }
  const revalidated = await planStandaloneFragmentAdd(ctx, item);
  assertDestructivePlanUnchanged(preflight.plan, revalidated.plan);
  return { proceed: true, pin: revalidated.pin };
}

function shelfPluginAddPoints(
  ref: string,
  runs: PluginRuns,
  local: boolean,
): PluginConsentPoint[] {
  return [
    { kind: "install", ref, runs },
    ...(local ? [] : [{ kind: "project-scope" as const, ref, runs }]),
  ];
}

/**
 * `ResultExitError` carries no message because the throwing command already
 * reported the detail.
 */
function errorDetail(cause: unknown): string {
  if (cause instanceof ResultExitError) return "";
  return firstErrorLine(cause);
}

function printInteractiveSummary(
  result: { added: string[]; alreadyInstalled: string[]; failed: string[] },
  local: boolean,
): void {
  const parts = [`${result.added.length} added`];
  if (result.alreadyInstalled.length > 0) {
    parts.push(`${result.alreadyInstalled.length} already installed`);
  }
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  console.log("");
  console.log(`${result.failed.length > 0 ? "!" : "✓"} ${parts.join(", ")}`);
  for (const ref of result.failed) {
    console.log(`  retry: capshelf add ${ref}${local ? " --local" : ""}`);
  }
}

async function loadRelationMetadata(
  bundle: Bundle,
  masterByRef: Map<string, MasterItem>,
  projectLock: Lock,
  localLock: Lock,
): Promise<Map<string, ItemMetadata>> {
  const wanted = new Set(bundle.members.map(memberRef));
  for (const lock of [projectLock, localLock]) {
    for (const key of Object.keys(lock.items)) {
      if (key.startsWith("data/")) wanted.add(key.slice("data/".length));
    }
  }
  const metadataByRef = new Map<string, ItemMetadata>();
  for (const ref of wanted) {
    const item = masterByRef.get(ref);
    if (!item) continue;
    const meta = await loadDataItemMetadata(item);
    printMetadataWarnings(meta);
    metadataByRef.set(ref, meta);
  }
  return metadataByRef;
}

type BundleMemberJsonStatus =
  | "added"
  | "already-installed"
  | "refused"
  | "missing"
  | "blocked";

function memberJsonStatus(
  member: MemberPlan,
  failed: boolean,
): BundleMemberJsonStatus {
  switch (member.status) {
    case "already-installed":
      return "already-installed";
    case "missing":
      return "missing";
    case "refused":
    case "cross-scope":
      return "refused";
    case "install":
      return failed ? "blocked" : "added";
  }
}

function printBundleJson(
  bundle: Bundle,
  plan: BundlePlan,
  ctx: AddContext,
  results: Map<string, InstallDataItemResult>,
): void {
  const failed = planFailures(plan).length > 0;
  const lock = ctx.local ? ctx.localLock : ctx.projectLock;
  const members = plan.members.map((member) => {
    const status = memberJsonStatus(member, failed);
    const result = results.get(member.ref);
    return {
      ref: member.ref,
      status,
      ...(status === "refused" && {
        reason: member.reason ?? "refused",
      }),
      ...(status === "already-installed" && {
        sha: memberIdentity(lock, member),
      }),
      ...(status === "added" &&
        result && {
          sha: result.sha,
          sourceCommit: result.sourceCommit,
          needs: result.needs,
          dst: relativeProjectPath(ctx.project, result.dst),
          ...(result.sources.length > 0 && {
            sources: fragmentSourcesJson(ctx.project, result),
          }),
          ...(result.runtimeWarnings.length > 0 && {
            runtimeWarnings: result.runtimeWarnings,
          }),
        }),
    };
  });
  console.log(
    JSON.stringify(
      {
        bundle: bundle.name,
        ...(bundle.description !== undefined && {
          description: bundle.description,
        }),
        scope: ctx.local ? "local" : "project",
        dataRepo: ctx.dataRepo,
        applied: !failed,
        members,
        added: results.size,
        alreadyInstalled: plan.members.filter(
          (m) => m.status === "already-installed",
        ).length,
        missingRequires: [
          ...new Set([...plan.missingRequiresByMember.values()].flat()),
        ],
        runtimeWarnings: collectRuntimeWarnings(results),
      },
      null,
      2,
    ),
  );
}

function printBundleSummary(
  bundle: Bundle,
  plan: BundlePlan,
  results: Map<string, InstallDataItemResult>,
): void {
  if (plan.members.length === 0) {
    console.log(
      `✓ bundle ${bundle.name} → nothing to install (bundle has no members)`,
    );
    return;
  }
  const already = plan.members.filter(
    (m) => m.status === "already-installed",
  ).length;
  console.log(
    `✓ bundle ${bundle.name} → ${results.size} added, ${already} already installed`,
  );
  for (const member of plan.members) {
    if (member.status === "already-installed") {
      console.log(`  = ${member.ref.padEnd(33)} already installed`);
      continue;
    }
    const result = results.get(member.ref);
    if (result) {
      console.log(
        `  + ${member.ref.padEnd(33)} @ ${shortIdentity(result.sha)}`,
      );
      printDeclaredNeeds(result.needs, "    ");
      printRuntimeWarnings(result.runtimeWarnings, "    ");
    }
  }
}

function printBundleRefusal(
  bundle: Bundle,
  plan: BundlePlan,
  failures: MemberPlan[],
  ctx: AddContext,
): void {
  if (
    plan.localUnsupportedMembers.length > 0 &&
    failures.length === plan.localUnsupportedMembers.length
  ) {
    console.log(
      `✗ not installing bundle ${bundle.name} --local — local scope supports copy-directory items only`,
    );
    console.log(
      `  ${localUnsupportedLabel(plan)}: ${plan.localUnsupportedMembers.join(", ")}`,
    );
    console.log(
      `  install the bundle at project scope instead: capshelf add bundles/${bundle.name}`,
    );
    return;
  }

  const ready = plan.members.filter(
    (m) => m.status === "install" || m.status === "already-installed",
  ).length;
  console.log(
    `✗ not installing bundle ${bundle.name} — ${failures.length} of ${plan.members.length} members failed preflight`,
  );
  if (plan.localUnsupportedMembers.length > 0) {
    console.log("  ✗ local scope supports copy-directory items only");
    console.log(
      `    ${localUnsupportedLabel(plan)}: ${plan.localUnsupportedMembers.join(", ")}`,
    );
    console.log(
      `    install the bundle at project scope instead: capshelf add bundles/${bundle.name}`,
    );
    failures = failures.filter(
      (m) => !plan.localUnsupportedMembers.includes(m.ref),
    );
  }
  for (const member of failures) {
    const reason =
      member.status === "missing"
        ? `not found in data repo (${homeRelative(ctx.dataRepo)})`
        : (member.reason ?? "refused");
    const [first = "", ...rest] = reason.split("\n");
    console.log(`  ✗ ${member.ref.padEnd(24)} ${first}`);
    for (const line of [...rest, ...(member.detail ?? [])]) {
      console.log(`    ${" ".repeat(24)} ${line.trim()}`);
    }
  }
  console.log(
    `  no changes were made (${ready} ${ready === 1 ? "member was" : "members were"} ready)`,
  );
  console.log(
    `  fix the failures above, then re-run: capshelf add bundles/${bundle.name}`,
  );
}

function localUnsupportedLabel(plan: BundlePlan): string {
  return plan.localUnsupportedMembers.every(
    (ref) =>
      ref.startsWith("settings/") ||
      ref.startsWith("mcp/") ||
      ref.startsWith("codex-config/"),
  )
    ? "fragment members"
    : "project-only members";
}

function collectRuntimeWarnings(
  results: Map<string, InstallDataItemResult>,
): RuntimeWarning[] {
  const seen = new Set<string>();
  const warnings: RuntimeWarning[] = [];
  for (const result of results.values()) {
    for (const warning of result.runtimeWarnings) {
      const key = JSON.stringify(warning);
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }
  return warnings;
}

function printDeclaredNeeds(needs: ItemNeeds, indent = "  "): void {
  const line = formatDeclaredNeeds(needs);
  if (line) console.log(`${indent}${line}`);
}

function itemRefLabel(item: MasterItem): string {
  return `${item.kind}/${item.name}`;
}

interface FragmentSourceJson {
  target: string;
  sourcePath: string;
  outputPath: string;
  outputAction: string;
}

function fragmentSourcesJson(
  project: string,
  result: InstallDataItemResult,
): FragmentSourceJson[] {
  return result.sources.map((source) => ({
    target: source.sourceTarget ?? source.target,
    sourcePath: source.relPath,
    outputPath: relativeProjectPath(
      project,
      fragmentOutputPath(project, source.target),
    ),
    outputAction:
      result.outputResults.find((r) => r.target === source.target)?.action ??
      "already-current",
  }));
}

async function enforceItemRelations(
  dataRepo: string,
  item: MasterItem,
  projectLock: Lock,
  localLock: Lock,
): Promise<string[]> {
  const meta = await loadDataItemMetadata(item);
  printMetadataWarnings(meta);
  const itemRef = `${item.kind}/${item.name}`;
  const installedKeys = new Set([
    ...Object.keys(projectLock.items),
    ...Object.keys(localLock.items),
  ]);
  installedKeys.delete(dataKey(item.kind, item.name));
  const refInstalled = (ref: string): boolean =>
    installedKeys.has(`data/${ref}`) || installedKeys.has(`system/${ref}`);

  const declared = meta.conflictsWith.find(
    (ref) => ref !== itemRef && refInstalled(ref),
  );
  if (declared) {
    throw conflictRefusal(dataRepo, itemRef, declared, item.repoRelPath);
  }

  const masterByRef = new Map(
    (await listMasterItems(dataRepo)).map((m) => [`${m.kind}/${m.name}`, m]),
  );
  for (const installedKey of installedKeys) {
    if (!installedKey.startsWith("data/")) continue;
    const installedRef = installedKey.slice("data/".length);
    const installedItem = masterByRef.get(installedRef);
    if (!installedItem) continue;
    const installedMeta = await loadDataItemMetadata(installedItem);
    printMetadataWarnings(installedMeta);
    if (installedMeta.conflictsWith.includes(itemRef)) {
      throw conflictRefusal(
        dataRepo,
        itemRef,
        installedRef,
        installedItem.repoRelPath,
      );
    }
  }

  return meta.requires.filter((ref) => ref !== itemRef && !refInstalled(ref));
}

function conflictRefusal(
  dataRepo: string,
  newRef: string,
  installedRef: string,
  declaringRepoRelPath: string,
): PreconditionError {
  const declaringSidecar = `${declaringRepoRelPath}/${METADATA_SIDECAR}`;
  return new PreconditionError(
    `not installing ${newRef} — conflicts with installed ${installedRef}\n` +
      `  declared by: ${declaringSidecar}\n` +
      "  fix by one of:\n" +
      `    - remove the conflicting item first: capshelf rm ${installedRef}\n` +
      `    - if the declaration is stale, edit ${join(dataRepo, ...declaringSidecar.split("/"))} and commit`,
  );
}

function printMissingRequires(
  refLabel: string,
  missingRequires: string[],
): void {
  if (missingRequires.length === 0) return;
  console.error(`⚠ missing required items for ${refLabel}:`);
  for (const ref of missingRequires) {
    console.error(`    ${ref} — install with: capshelf add ${ref}`);
  }
}

function addToManifest(m: Manifest, item: MasterItem): void {
  addManifestName(m, item.kind, item.name);
}

/**
 * v4 data entries carry no `sha` (they use `sourcePinDigest`), so go through
 * `entryIdentity`.
 */
function memberIdentity(lock: Lock, member: MemberPlan): string | undefined {
  const entry = lock.items[dataKey(member.kind, member.name)];
  return entry ? entryIdentity(entry) : undefined;
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}
