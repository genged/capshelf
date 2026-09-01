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
import { saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { addManifestName, manifestNamesForKind } from "../manifest";
import {
  assertLockV4,
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
import { materializeLockEntry } from "../materialize";
import {
  allCanonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
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
import { isSystemItemName } from "../bundled";
import { assertPathClean, objectTypeAtCommit, showAtCommit } from "../git";
import { findMasterItemByRef, lockKeyForRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
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
}

/** Everything the single-item installer needs; loaded once per command. */
export interface AddContext {
  project: string;
  dataRepo: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  localConfig: LocalConfig | null;
  local: boolean;
}

export interface InstallDataItemResult {
  sha: string;
  sourceCommit: string;
  dst: string;
  wasAlreadyInstalled: boolean;
  sources: FragmentSource[];
  /** Runtime target coverage for `mcp` and `subagents`; null for other kinds. */
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
    .option("--json", "output JSON")
    .action(
      async (itemRef: string | undefined, opts: AddOptions, cmd: Command) => {
        if (itemRef === undefined) {
          // The same refusal `addOne` makes. Without it here, the no-argument
          // branch returns before either of those checks, so
          // `capshelf add --target codex` opened the picker and installed
          // every available runtime target while silently ignoring the flag.
          if (opts.target) {
            throw new PreconditionError(
              "add --target is not supported; subagents and bundles install all available targets",
            );
          }
          // `--json` names a scripted caller, and a script cannot answer a
          // prompt. Refusing beats printing a picker to stderr and an empty
          // result to stdout, which reads as "the shelf is empty".
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
          // Any failed item is a refusal the user needs a non-zero code for;
          // each one already printed its reason and its retry command.
          if (summary.outcome === "installed" && summary.failed.length > 0) {
            throw new ResultExitError(3);
          }
          return;
        }
        await addOne(itemRef, opts, cmd);
      },
    );
}

/** Install one explicitly named item ref, or expand one named bundle. */
async function addOne(
  itemRef: string,
  opts: AddOptions,
  cmd: Command,
): Promise<void> {
  // Bundle refs branch BEFORE parseItemRef: the parser rejects "bundles"
  // as an item kind, so testing afterwards would be dead code behind an
  // exit-1 throw.
  const bundleName = isBundleRef(itemRef);
  if (bundleName !== null) {
    if (opts.target) {
      throw new PreconditionError(
        "add --target is not supported; subagents and bundles install all available targets",
      );
    }
    await addBundle(bundleName, opts, cmd);
    return;
  }

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

  const consent = await approveFragmentPin(ctx, item, {
    json: opts.json === true,
    yes: opts.yes === true,
  });
  if (!consent.proceed) return;

  const result = await installDataItem(ctx, item, {
    ...(consent.pin && { pin: consent.pin }),
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
  printDeclaredNeeds(result.needs);
  printRuntimeWarnings(result.runtimeWarnings);
  printMissingRequires(`${item.kind}/${item.name}`, result.missingRequires);
}

/**
 * `dataRepo` lets a caller supply a path it has already resolved and checked.
 *
 * `init` must: commander binds a `--data` written before the subcommand — and
 * a bare `capshelf init --data <url>` is parsed that way — to the *root*
 * command, so `globalOpts(cmd).data` can hold a remote URL. Resolving that
 * again here treats the URL as a filesystem path and fails on a directory
 * named `file:/...` under the project. `init` has already turned it into a
 * local clone path and asserted it is a git repo, so it passes that instead.
 */
async function loadAddContext(
  opts: AddOptions,
  cmd: Command,
  dataRepo?: string,
): Promise<AddContext> {
  const base = await loadProjectContext({
    cmd,
    dataRepo: dataRepo === undefined,
  });
  const localConfig = await loadLocalConfig(base.project);
  return {
    ...base,
    // Resolved above, or supplied by a caller that already resolved it.
    dataRepo: dataRepo ?? base.dataRepo!,
    localConfig,
    local: opts.local ?? false,
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
  // This branch returns from the lock entry before any master item is
  // resolved, and a locked sourceCommit can be unreachable — history
  // rewritten upstream, or a clone that never fetched it. Coverage then
  // degrades to `unknown` rather than crashing the most likely way a user
  // checks what an item covers: re-running `add`.
  const targetCoverage =
    entry.source === "data"
      ? await itemTargetCoverageAtCommit(
          ctx.project,
          ctx.dataRepo,
          parsed.kind,
          parsed.name,
          entry.sourceCommit,
        )
      : null;
  const missingRequires =
    entry.source === "data"
      ? (
          await loadCommittedItemNeeds(
            ctx.dataRepo,
            { kind: parsed.kind, name: parsed.name },
            entry.sourceCommit,
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
      // Only for the state it describes. A squash-merged commit is re-pinned
      // by `sync-data && update`; an object database that does not read is
      // not, and pointing at that repair would send the user somewhere the
      // problem is not.
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
 * The preflight plan and the pin it was built from. The pin travels to
 * `installDataItem` so the tree the user consented to is the tree that gets
 * written: pinning again after `assertDestructivePlanUnchanged` would let a
 * data-repo commit landing in that window add a target the consent gate never
 * saw, and TOML comment loss is gated, not announced.
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
    pinCurrentSource(ctx.dataRepo, item.kind, item.name),
    captureCommittedItemNeeds(ctx.dataRepo, item),
  ]);
  const nextManifest = structuredClone(ctx.manifest);
  addToManifest(nextManifest, item);
  const nextLock = assertLockV4(
    structuredClone(ctx.projectLock),
    "capshelf add",
  );
  const nextEntry = createDataLockEntry({ pin, ...snapshot });
  nextLock.items[dataKey(item.kind, item.name)] = nextEntry;
  // Read the pin, not the worktree. `assertFragmentSourcesClean` cannot see a
  // dirty deletion — `canonicalItemRelPaths` drops the missing path before the
  // cleanliness check runs (`src/master.ts:355-357`,
  // `src/fragments.ts:341-349`) — so a worktree read would plan no destruction
  // for a target the install then writes from the pin, and a commented
  // `.codex/config.toml` would be rewritten without the consent gate TOML
  // comment loss requires (`src/fragments.ts:112-114`).
  //
  // The pin's own listing, not a second read of the same commit: this must be
  // the exact target set `installDataItem` writes, or the consent gate covers
  // a different set than the install does.
  await assertPinnedSourcesReadable(ctx.dataRepo, item, pin);
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
      }),
    );
    const contributionState = await fragmentContributionState(
      ctx.project,
      ctx.dataRepo,
      ctx.manifest,
      ctx.projectLock,
      target,
    );
    contributionStates.set(target, contributionState);
    // A review command only when `status --diff` can display the loss. Status
    // reports lock entries, so it reaches this target's file only through an
    // already-tracked contributor whose row has a diff to print — and only
    // drifted parsed values give it one. On a first add nothing contributes,
    // and comment-only loss parses identical to the managed output, so the
    // named command would print "(no items tracked)" or
    // "(no content differences)" under the prompt that cited it.
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

/**
 * Every canonical source the pin lists must read before anything is planned,
 * consented to, or written.
 *
 * `ls-tree` names a path without opening its blob, and the merge that follows
 * (`fragmentValuesForTarget`) treats a failed `git show` as an absent
 * contribution. An unreadable pinned blob would therefore be planned as
 * nothing and consented to as nothing — and if the object became readable in
 * the window before the write, merged in without ever passing the gate. The
 * commit and the pin digest are identical throughout, so the plan snapshot
 * cannot see that transition; refusing the unreadable object up front can.
 */
async function assertPinnedSourcesReadable(
  dataRepo: string,
  item: MasterItem,
  pin: PinnedSource,
): Promise<void> {
  if (!isFragmentItemKind(item.kind)) return;
  // A canonical path committed as a *directory* is invisible to exact-path
  // matching — `ls-tree -r` names it only through its descendants, and an
  // empty tree has none at all — so the target reads as absent and the install
  // goes through. `apply` then probes `git show <commit>:<path>`, which
  // resolves the tree, hands its listing to the JSON or TOML parser, and fails
  // after the lock was saved. Asking Git the object type answers both shapes
  // at once, and keeps the failure where the worktree-derived preflight used
  // to put it: before any state is written.
  for (const relPath of allCanonicalItemRelPaths(item.kind, item.name)) {
    if (
      (await objectTypeAtCommit(dataRepo, pin.sourceCommit, relPath)) === "tree"
    ) {
      throw new PreconditionError(
        `${relPath} is a directory at ${pin.sourceCommit}\n` +
          "  a canonical source must be a regular file; remove or rename the directory in the data repo and commit",
      );
    }
  }
  const sources = presentSources(
    fragmentTargetPresenceInPaths(
      item.kind,
      item.name,
      pin.entries.map((entry) => entry.repoRelPath),
    ),
  );
  for (const source of sources) {
    try {
      await showAtCommit(dataRepo, pin.sourceCommit, source.relPath);
    } catch (cause) {
      throw new PreconditionError(
        `cannot read ${source.relPath} at ${pin.sourceCommit}\n` +
          "  the pin names this source but the data repo cannot produce its content; no changes were written",
        { cause },
      );
    }
  }
}

export interface InstallDataItemOptions {
  /**
   * Sidecar relations (`requires`/`conflicts-with`) enforcement. The bundle
   * executor disables it: bundle preflight already ran the symmetric
   * conflict check against installed items AND sibling members, and bundle
   * `requires` warnings are computed against installed ∪ members.
   */
  enforceRelations?: boolean;
  /**
   * The pin the destructive-change preflight was accepted against. Reusing it
   * makes the approved tree the written tree; pinning again here would reopen
   * the window between revalidation and the write.
   */
  pin?: PinnedSource;
}

/**
 * The load/check/copy/lock core shared by standalone `add` and the bundle
 * executor. Persists manifest + lock before returning, so bundle expansion
 * leaves a consistent prefix after a mid-install failure.
 *
 * Deliberately has no internal skip guard: standalone `add` returns before
 * calling this for installed items, and the bundle executor likewise calls it
 * only for members whose plan status is `install`.
 */
export async function installDataItem(
  ctx: AddContext,
  item: MasterItem,
  opts: InstallDataItemOptions = {},
): Promise<InstallDataItemResult> {
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

  // Refuse to add from a dirty path. Otherwise the locked sha (hashed from
  // working tree) would not match git show <sourceCommit> (the last commit
  // touching the path), leaving apply/revert with the wrong content.
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
  // A worktree read, and safe here, unlike the fragment one it sits next to.
  // Subagent cleanliness is checked over `allCanonicalItemRelPaths` — the
  // static pair, not the `existsSync`-filtered list `assertFragmentSourcesClean`
  // uses — so a dirty-deleted or uncommitted canonical source refuses the whole
  // `add` above before this runs. The worktree and the pin therefore cannot
  // disagree at this point. It feeds `dst` alone; the install itself is
  // `materializeSubagent`, which resolves its targets with
  // `subagentSourcesAtCommit` at the pinned commit (`src/subagents.ts:350-355`).
  const subagentSources =
    item.kind === "subagents"
      ? await currentSubagentSources(project, dataRepo, item.name)
      : [];

  if (item.kind === "skills") {
    const external = await findSkillsShSkill(project, item.name);
    if (external) {
      throw new PreconditionError(
        `not installing ${item.kind}/${item.name} — ${skillsShConflictMessage(external)}`,
      );
    }
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

  // One pin, built in one place from the committed tree (PIN-1, PIN-2). The
  // refusals it carries — an external filter driver (PIN-9), a symlink or
  // gitlink in the tree — happen here, before any manifest or lock mutation.
  const pin =
    opts.pin ?? (await pinCurrentSource(dataRepo, item.kind, item.name));
  // PIN-3 for fragments: the target set comes from the tree this install pins,
  // exactly as `apply` derives it from the lock. A worktree read made `add` and
  // `apply` disagree about one lock entry — a dirty-deleted
  // `mcp/<n>/codex.toml` left `.codex/config.toml` unwritten until an unrelated
  // `apply` ran. The pin's own `ls-tree` is the reading: it is the tree that
  // gets written, and it raises on a failed read rather than reporting one as
  // an absent source.
  const pinnedPaths = pin.entries.map((entry) => entry.repoRelPath);
  const sources = isFragmentItemKind(item.kind)
    ? presentSources(
        fragmentTargetPresenceInPaths(item.kind, item.name, pinnedPaths),
      )
    : [];
  // The install branch always resolves the item and pins a fresh tree, so
  // coverage is never unknown here.
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
  // Only when this call produced the pin. A supplied `opts.pin` came from
  // `planStandaloneFragmentAdd`, which validated it as it built the plan the
  // user consented to; re-reading the same blobs here proves nothing new and
  // costs one subprocess per canonical source, per member, on every add.
  if (opts.pin === undefined) {
    await assertPinnedSourcesReadable(dataRepo, item, pin);
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
  const snapshot = await captureCommittedItemNeeds(dataRepo, item);
  let adoptMatchingInstall = false;
  if (!alreadyInLock && conflict) {
    if (isCopyDirectoryItemKind(item.kind)) {
      adoptMatchingInstall = await matchesPinnedInstall(
        ctx,
        item,
        conflict,
        pin,
      );
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
  const writableLock = assertLockV4(lock, "capshelf add");
  const previousEntry = writableLock.items[key];
  writableLock.items[key] = createDataLockEntry({
    pin,
    ...snapshot,
  });

  const outputResults: FragmentApplyResult[] = [];
  if (isFragmentItemKind(item.kind)) {
    for (const target of [...new Set(sources.map((source) => source.target))]) {
      outputResults.push(
        await applyFragmentOutput({
          project,
          dataRepo,
          manifest,
          oldLock,
          nextLock: writableLock,
          target,
        }),
      );
    }
  } else if (isCopyDirectoryItemKind(item.kind)) {
    // PIN-3: `add` materializes from the commit's blobs, exactly as `apply`
    // does, instead of copying the data repo working tree. The asymmetry that
    // made the original bug invisible from inside a project is gone: both
    // routes now read the same objects, so they cannot disagree.
    await materializeLockEntry({
      project,
      dataRepo,
      manifest,
      key,
      entry: writableLock.items[key]!,
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
 * Recovery adoption: an unmanaged target is adopted only when it already holds
 * exactly what the pin selects. Under tree identity that is one comparison —
 * the installed tree's digest against the pin — and it needs no blob reads,
 * because both sides are named by Git object ids.
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

/** Expand `add bundles/<name>`: load → preflight → refuse or install. */
async function addBundle(
  name: string,
  opts: AddOptions,
  cmd: Command,
  dataRepo?: string,
): Promise<void> {
  const ctx = await loadAddContext(opts, cmd, dataRepo);
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
    masterByRef,
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

  // Bundles are the recommended entry point (`capshelf init` suggests
  // `capshelf add bundles/<name>`), so the consent boundary has to be reached
  // here too. Without this, the same fragment destruction was gated for
  // `add settings/extra` and ungated for the bundle that contains it.
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
      // A bundle's write window is the longest one there is — every member
      // installs after one shared revalidation — so each fragment member
      // installs the exact tree its own preflight approved.
      const approved = revalidated.pins.get(member.ref);
      return installDataItem(ctx, item, {
        enforceRelations: false,
        ...(approved && { pin: approved }),
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

/**
 * A discriminated union rather than one shape with optional fields: only the
 * `installed` outcome has per-item results, and only `unavailable` has a
 * reason. Callers then read the fields that exist instead of asserting.
 */
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
 * The interactive install path, shared by `capshelf add` with no argument and
 * the offer at the end of `capshelf init`.
 *
 * Best effort by design, unlike `add bundles/<name>`. A bundle is a curated
 * set whose author asserted the members belong together, so a member that
 * fails preflight refuses the whole thing. A picker selection is a pile of
 * independent choices a user made one Tab at a time, and throwing away nine
 * good ones because the tenth has an occupied target would be hostile. Every
 * failure is named at the end with the command that retries just that item.
 *
 * Returns the summary rather than setting an exit code: `add` treats any
 * failure as exit 3, while `init` reports and exits 0, because init's exit
 * code answers "is this project initialized" and it is.
 */
export async function runInteractiveAdd(request: {
  add: AddOptions;
  cmd: Command;
  message: string;
  /** An already-resolved data repo path; see `loadAddContext`. */
  dataRepo?: string;
}): Promise<InteractiveAddSummary> {
  const { add: opts, cmd, message, dataRepo } = request;
  // Before any filesystem work: with no terminal there is nothing to offer,
  // and reading the shelf could refuse for reasons that belong to `ls`.
  const blocked = pickTerminalUnavailable();
  if (blocked) return { outcome: "unavailable", reason: blocked };

  let ctx = await loadAddContext(opts, cmd, dataRepo);
  // Pin the repository the catalog is read from, and install from that one.
  //
  // A plain `capshelf add` resolves the binding from `.capshelf/local.json`,
  // and every reload below would resolve it again. `capshelf data bind` in
  // another terminal while the picker is open would then move the binding
  // under it, and refs the user chose from one shelf would be installed from
  // another. Reloading is for the locks, not for the binding.
  //
  // Every reload goes through `reload`, so the pin is structural rather than
  // remembered. A reload added later cannot re-resolve the binding by
  // forgetting to pass it.
  const boundRepo = ctx.dataRepo;
  const reload = (): Promise<AddContext> =>
    loadAddContext(opts, cmd, boundRepo);
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

  // Reload before any write. The context above was read before the prompt, and
  // the prompt then held the terminal for as long as the user looked at it —
  // an unbounded wait no other capshelf command has. `installDataItem` saves
  // the manifest and lock from whatever snapshot it is handed, so writing from
  // that one would silently drop every entry another capshelf run made while
  // the picker was open. It is the same failure the post-bundle reload below
  // exists for, with a much wider window.
  //
  // This narrows the window to the one every other command already has,
  // between its own read and its own write. It does not make the write atomic;
  // serializing capshelf against itself would need a lock file and belongs to
  // every command at once, not to this one.
  ctx = await reload();

  const added: string[] = [];
  const alreadyInstalled: string[] = [];
  const failed: string[] = [];

  // Bundles first, and each through the ordinary all-or-nothing bundle path:
  // a bundle keeps its own semantics even when a picker chose it. Its members
  // may satisfy an individually picked item's `requires`, which is the other
  // reason this order is not arbitrary.
  const bundleNames = picked.refs
    .map((ref) => isBundleRef(ref))
    .filter((name): name is string => name !== null);
  for (const name of bundleNames) {
    try {
      await addBundle(name, opts, cmd, boundRepo);
      added.push(`bundles/${name}`);
    } catch (error) {
      // `addBundle` prints its own refusal before throwing ResultExitError, so
      // a code-only error needs no second message here.
      failed.push(`bundles/${name}`);
      const detail = errorDetail(error);
      if (detail) console.error(`✗ bundles/${name} — ${detail}`);
    }
  }

  // Reload: every `addBundle` above resolved its own context and saved its own
  // lock. Reusing the context loaded before them would write a lock built from
  // a snapshot that predates their entries, silently dropping every member
  // they just installed.
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
      // The same refusal a named `add` makes. The catalog already leaves these
      // rows out, so this is the boundary check rather than the only one: both
      // entry points into `installDataItem` have to enforce it. A data repo
      // holding `skills/capshelf` would otherwise install `data/skills/capshelf`
      // next to `system/skills/capshelf`, giving two lock entries ownership of
      // one destination.
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(systemItemAddRefusal(ref.name));
      }
      const item = await findMasterItemByRef(boundRepo, ref);
      if (!item) {
        throw new NotFoundError(
          `not found in data repo (${homeRelative(boundRepo)}): ${itemRef}`,
        );
      }

      // The same consent gate a named `add` reaches. A fragment picked from
      // a list can destroy a config comment exactly as one typed by hand.
      const consent = await approveFragmentPin(ctx, item, {
        json: false,
        yes: opts.yes === true,
      });
      if (!consent.proceed) {
        failed.push(itemRef);
        continue;
      }

      const result = await installDataItem(ctx, item, {
        ...(consent.pin && { pin: consent.pin }),
      });
      added.push(itemRef);
      console.log(`+ ${itemRef.padEnd(33)} @ ${shortIdentity(result.sha)}`);
      // Same block a named `add` prints. `mcp` and `subagents` items write a
      // per-runtime set of targets, and the documented contract is that `add`
      // says which runtimes it covered. A coverage gap is not a runtime
      // warning, so the call below cannot stand in for this one.
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
      // Reload before continuing. `installDataItem` adds the item to the
      // manifest and the lock *before* it materializes, so a failure between
      // those two steps leaves this context holding an entry for an item that
      // was never written. The next item that succeeds calls `saveManifest`
      // and `saveLock` on these same objects, which would persist the failed
      // item's entry and claim an install that is absent or half-written.
      ctx = await reload();
    }
  }

  printInteractiveSummary({ added, alreadyInstalled, failed }, ctx.local);
  return { outcome: "installed", added, alreadyInstalled, failed };
}

/** The refusal both entry points into `installDataItem` print for a system name. */
function systemItemAddRefusal(name: string): string {
  return `"${name}" is a system item — managed by the CLI, not addable from a data repo. It is installed automatically by 'capshelf init'.`;
}

/**
 * The fragment consent gate both entry points into `installDataItem` run: a
 * fragment picked from a list can destroy a config comment exactly as one
 * typed by hand. Preflight, confirm, then re-plan and prove the plan
 * unchanged — the consent was for the plan the user saw. A non-fragment item
 * has no gate and proceeds with no pin.
 */
async function approveFragmentPin(
  ctx: Awaited<ReturnType<typeof loadAddContext>>,
  item: MasterItem,
  opts: { json: boolean; yes: boolean },
): Promise<{ proceed: boolean; pin: PinnedSource | null }> {
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

/**
 * A one-line reason for a per-item failure. `ResultExitError` carries no
 * message because the command that threw it already reported the detail.
 */
function errorDetail(error: unknown): string {
  if (error instanceof ResultExitError) return "";
  return firstErrorLine(error);
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
  // Metadata for the members (forward checks) plus every installed data
  // item (reverse conflicts) — same population standalone add consults.
  const wanted = new Set(bundle.members.map(memberRef));
  for (const lock of [projectLock, localLock]) {
    for (const key of Object.keys(lock.items)) {
      if (key.startsWith("data/")) wanted.add(key.slice("data/".length));
    }
  }
  const metadataByRef = new Map<string, ItemMetadata>();
  for (const ref of wanted) {
    const item = masterByRef.get(ref);
    if (!item) continue; // deleted upstream: skipped, never failed
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
      // This member was fine; another member's failure stopped the bundle.
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
  // The --local copy-item rule gets ONE aggregated bundle-level error
  // naming every fragment member, never the first-violator per-kind message.
  // When it is the only failure kind, it is the headline; mixed with other
  // failures it becomes a block under a single headline whose count covers
  // every failed member.
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

function fragmentSourcesJson(
  project: string,
  result: InstallDataItemResult,
): Array<Record<string, unknown>> {
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

/**
 * Enforce sidecar-declared relations before any writes.
 *
 * `conflicts-with` refuses (exit 3) and the check is symmetric: the new item
 * declaring a conflict with an installed item, or any installed data item
 * declaring a conflict with the new item, both refuse. There is no --force —
 * the two legitimate escape hatches (remove the other item, or fix a stale
 * declaration upstream) are printed in the error.
 *
 * `requires` only warns: the returned refs are missing from both locks and
 * are reported with exact fix commands (exit stays 0; exit 5 is reserved for
 * a future doctor/strict audit). Refs pointing at items deleted upstream are
 * reported as missing requires / skipped for conflicts — add never fails
 * because someone deleted a referenced item.
 */
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
  // Re-adding an item must not conflict with (or require) itself.
  installedKeys.delete(dataKey(item.kind, item.name));
  const refInstalled = (ref: string): boolean =>
    installedKeys.has(`data/${ref}`) || installedKeys.has(`system/${ref}`);

  const declared = meta.conflictsWith.find(
    (ref) => ref !== itemRef && refInstalled(ref),
  );
  if (declared) {
    throw conflictRefusal(dataRepo, itemRef, declared, item.repoRelPath);
  }

  // Reverse direction: conflict relations are symmetric, so an installed
  // item's declaration against the new item refuses too.
  const masterByRef = new Map(
    (await listMasterItems(dataRepo)).map((m) => [`${m.kind}/${m.name}`, m]),
  );
  for (const installedKey of installedKeys) {
    if (!installedKey.startsWith("data/")) continue;
    const installedRef = installedKey.slice("data/".length);
    const installedItem = masterByRef.get(installedRef);
    // Deleted upstream: its declarations cannot be read — skip, never fail.
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
 * A bundle member's locked identity. Version-4 data entries carry no `sha` —
 * `createDataLockEntry` writes `sourcePinDigest` — so reading the field
 * directly dropped the key out of `--json` entirely rather than erroring.
 */
function memberIdentity(lock: Lock, member: MemberPlan): string | undefined {
  const entry = lock.items[dataKey(member.kind, member.name)];
  return entry ? entryIdentity(entry) : undefined;
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}
