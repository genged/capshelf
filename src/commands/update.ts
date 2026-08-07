import type { Command } from "commander";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  createDestructiveChangePlan,
  renderDestructiveChanges,
  type DestructiveChange,
  type DestructiveChangePlan,
} from "../destructive-change";
import {
  planCopyDirectoryDestruction,
  planFragmentDestruction,
  planSubagentDestruction,
} from "../destructive-preflight";
import type { Manifest } from "../manifest";
import {
  needsEqual,
  refreshDataLockEntry,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntry, Lock, LockEntry, SystemLockEntry } from "../lock";
import { parseLockKey, shaOfInstalled } from "../installed";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  shaOfGitVisibleItem,
} from "../master";
import { assertRepoClean, lastTouchingContentCommit } from "../git";
import { PRODUCT_NAME } from "../identity";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { PreconditionError, ResultExitError } from "../errors";
import { assertLocalScopeSupported } from "../local-config";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { resolveTrackedTarget } from "../targets";
import type { ScopedTarget } from "../targets";
import { materializeLockEntry } from "../materialize";
import { listSkillsShSkills, skillsShConflictMessage } from "../external";
import type { ExternalSkill } from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  applyFragmentOutputPlans,
  fragmentContributionState,
  fragmentKindForTarget,
  fragmentTargetKey,
  lastTouchingFragmentCommit,
  planFragmentOutput,
  shaOfFragmentItem,
  touchedFragmentTargetsForItem,
  type FragmentApplyResult,
  type FragmentOutputPlan,
  type FragmentTarget,
} from "../fragments";
import { captureCommittedItemNeeds } from "../metadata";
import {
  lastTouchingSubagentCommit,
  materializeSubagent,
  shaOfCurrentSubagent,
  shaOfInstalledSubagent,
} from "../subagents";

interface UpdateOptions {
  json?: boolean;
  dryRun?: boolean;
  local?: boolean;
  yes?: boolean;
}

type UpdateAction =
  | "updated"
  | "would-update"
  | "already-current"
  | "reconciled"
  | "would-reconcile"
  | "kept-local"
  | "skipped-external"
  | "error";

interface UpdateResult {
  key: string;
  source: string;
  kind: string;
  name: string;
  action: UpdateAction;
  sha?: string | null;
  currentSha?: string | null;
  lockedSha?: string;
  plannedSha?: string | null;
  sourceCommit?: string;
  cliVersion?: string;
  dryRun?: true;
  localReason?: string;
  error?: string;
  runtimeWarnings?: RuntimeWarning[];
  scope?: "project" | "local";
}

export function registerUpdate(program: Command): void {
  program
    .command("update [items...]")
    .description("bump lock pointers to current upstream content, then apply")
    .option(
      "--dry-run",
      "preview planned lock and file changes without writing",
    )
    .option("--local", "update local-scope items")
    .option("--yes", "overwrite local changes without prompting")
    .option("--json", "output JSON")
    .action(
      async (
        itemRefs: string[] | undefined,
        opts: UpdateOptions,
        cmd: Command,
      ) => {
        const refs = itemRefs ?? [];
        if (opts.local) {
          for (const itemRef of refs) {
            const ref = parseItemRef(itemRef);
            if (ref.kind) {
              assertLocalScopeSupported(ref.kind, ref.name, "update --local");
            }
          }
        }
        const { project, manifest, projectLock, localLock } =
          await loadProjectContext({ cmd });
        const explicit = refs.length > 0;

        const targets: ScopedTarget[] = [];
        if (refs.length > 0) {
          for (const itemRef of refs) {
            targets.push(
              await resolveTrackedTarget(
                project,
                projectLock,
                localLock,
                itemRef,
                { local: opts.local, verb: "updating" },
              ),
            );
          }
        } else {
          const selectedLock = opts.local ? localLock : projectLock;
          const scope: "project" | "local" = opts.local ? "local" : "project";
          targets.push(
            ...Object.keys(selectedLock.items).map((key) => ({
              scope,
              key,
            })),
          );
        }

        const needsDataRepo = targets.some(({ scope, key }) => {
          const lock = scope === "local" ? localLock : projectLock;
          const entry = lock.items[key]!;
          return entry.source === "data" && entry.local !== true;
        });
        const dataRepo = needsDataRepo
          ? await resolveProjectDataRepo(project, manifest, cmd)
          : undefined;
        if (dataRepo) {
          await assertRepoClean(dataRepo);
        }

        const results: UpdateResult[] = [];
        let projectChanged = false;
        let localChanged = false;
        const externalSkills = await listSkillsShSkills(project);
        const externalSkillByName = new Map(
          externalSkills.map((skill) => [skill.name, skill]),
        );
        const originalLock = structuredClone(projectLock);
        const fragmentNextLock = structuredClone(projectLock);
        const pendingFragmentEntries = new Map<string, LockEntry>();
        const touchedFragmentTargets = new Set<FragmentTarget>();
        let fragmentLockChanged = false;

        const ctx: UpdateContext = {
          project,
          manifest,
          dataRepo,
          dryRun: opts.dryRun === true,
          explicit,
          externalSkillByName,
        };

        const preflight = await planUpdatePreflight(
          ctx,
          targets,
          projectLock,
          localLock,
        );
        if (opts.dryRun) {
          printUpdateOutput({
            project,
            dataRepo,
            dryRun: true,
            results: preflight.results,
            destructivePlan: preflight.destructivePlan,
            json: opts.json === true,
          });
          if (preflight.results.some((result) => result.action === "error")) {
            throw new ResultExitError(1);
          }
          return;
        }
        if (preflight.results.some((result) => result.action === "error")) {
          printUpdateOutput({
            project,
            dataRepo,
            dryRun: false,
            results: preflight.results,
            destructivePlan: preflight.destructivePlan,
            json: opts.json === true,
          });
          throw new ResultExitError(1);
        }
        if (
          !(await confirmDestructiveChanges(preflight.destructivePlan, {
            operation: "Update",
            json: opts.json === true,
            yes: opts.yes === true,
            dryRun: false,
            rerunCommand: updateRerunCommand(refs, opts.local === true),
          }))
        ) {
          return;
        }
        const revalidated = await planUpdatePreflight(
          ctx,
          targets,
          projectLock,
          localLock,
        );
        assertDestructivePlanUnchanged(
          preflight.destructivePlan,
          revalidated.destructivePlan,
        );

        // Each target is planned in isolation and returns an explicit effect;
        // the loop is the only place the shared accumulators are mutated, so
        // their consistency no longer depends on reading a 380-line body.
        for (const target of targets) {
          const { scope, key } = target;
          const lock = scope === "local" ? localLock : projectLock;
          const entry = lock.items[key]!;
          const outcome = await updateOneTarget(ctx, target, entry);
          results.push(outcome.result);
          if (outcome.fragment) {
            const contribution = outcome.fragment;
            fragmentNextLock.items[contribution.key] = contribution.entry;
            pendingFragmentEntries.set(contribution.key, contribution.entry);
            for (const fragmentTarget of contribution.targets) {
              touchedFragmentTargets.add(fragmentTarget);
            }
            fragmentLockChanged =
              fragmentLockChanged || contribution.lockChanged;
          } else if (!ctx.dryRun && outcome.newEntry) {
            lock.items[key] = outcome.newEntry;
            if (outcome.changed) {
              if (scope === "local") localChanged = true;
              else projectChanged = true;
            }
          }
        }

        if (touchedFragmentTargets.size > 0 && dataRepo) {
          // Reconcile each target independently and report failures under that
          // target's own key/kind (matching apply) instead of a single
          // hardcoded data/fragments/(merged)/settings row that names a shape
          // no other command emits. Only commit the fragment lock bumps if
          // every reconcile succeeded, preserving the original all-or-nothing.
          let reconcileFailed = false;
          const plans: FragmentOutputPlan[] = [];
          for (const target of touchedFragmentTargets) {
            try {
              plans.push(
                await planFragmentOutput({
                  project,
                  dataRepo,
                  manifest,
                  oldLock: originalLock,
                  nextLock: fragmentNextLock,
                  target,
                }),
              );
            } catch (err) {
              reconcileFailed = true;
              results.push({
                key: fragmentTargetKey(target),
                source: "data",
                kind: fragmentKindForTarget(target),
                name: "(merged)",
                action: "error",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!reconcileFailed) {
            try {
              const appliedResults = await applyFragmentOutputPlans(plans, {
                dryRun: opts.dryRun,
              });
              for (const applied of appliedResults) {
                if (applied.action !== "already-current") {
                  results.push(fragmentMergedUpdateResult(applied));
                }
              }
            } catch (err) {
              reconcileFailed = true;
              const target =
                plans[0]?.target ?? [...touchedFragmentTargets][0]!;
              results.push({
                key: fragmentTargetKey(target),
                source: "data",
                kind: fragmentKindForTarget(target),
                name: "(merged)",
                action: "error",
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (!opts.dryRun && !reconcileFailed) {
            for (const [key, entry] of pendingFragmentEntries) {
              projectLock.items[key] = entry;
            }
            projectChanged = projectChanged || fragmentLockChanged;
          }
        }

        if (projectChanged) await saveLock(project, projectLock);
        if (localChanged) await saveLocalLock(project, localLock);

        printUpdateOutput({
          project,
          dataRepo,
          dryRun: false,
          results,
          destructivePlan: preflight.destructivePlan,
          json: opts.json === true,
        });
        if (results.some((r) => r.action === "error")) {
          throw new ResultExitError(1);
        }
      },
    );
}

interface UpdateContext {
  project: string;
  manifest: Manifest;
  dataRepo: string | undefined;
  dryRun: boolean;
  explicit: boolean;
  externalSkillByName: Map<string, ExternalSkill>;
}

interface UpdatePreflight {
  results: UpdateResult[];
  destructivePlan: DestructiveChangePlan;
}

async function planUpdatePreflight(
  ctx: UpdateContext,
  targets: ScopedTarget[],
  projectLock: Lock,
  localLock: Lock,
): Promise<UpdatePreflight> {
  const dryContext = { ...ctx, dryRun: true };
  const results: UpdateResult[] = [];
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  const fragmentNextLock = structuredClone(projectLock);
  const fragmentTargets = new Set<FragmentTarget>();
  const fragmentItems = new Map<FragmentTarget, Set<string>>();

  for (const target of targets) {
    const lock = target.scope === "local" ? localLock : projectLock;
    const currentEntry = lock.items[target.key]!;
    const outcome = await updateOneTarget(dryContext, target, currentEntry);
    results.push(outcome.result);
    snapshotParts.push(
      `update-result:${target.scope}:${target.key}:${JSON.stringify(outcome.result)}`,
    );
    if (outcome.result.action === "error") continue;

    const parsed = parseLockKey(target.key);
    const selectedEntry = outcome.fragment?.entry ?? outcome.newEntry;
    if (selectedEntry) {
      snapshotParts.push(
        `update-entry:${target.scope}:${target.key}:${lockEntrySnapshot(selectedEntry)}`,
      );
    }
    if (outcome.fragment) {
      fragmentNextLock.items[target.key] = outcome.fragment.entry;
      for (const fragmentTarget of outcome.fragment.targets) {
        fragmentTargets.add(fragmentTarget);
        const items = fragmentItems.get(fragmentTarget) ?? new Set<string>();
        items.add(`${parsed.kind}/${parsed.name}`);
        fragmentItems.set(fragmentTarget, items);
      }
      continue;
    }
    if (!selectedEntry || outcome.result.action === "kept-local") continue;

    const reviewCommand = itemReviewCommand(
      parsed.kind,
      parsed.name,
      target.scope,
    );
    if (isCopyDirectoryItemKind(parsed.kind)) {
      const planned = await planCopyDirectoryDestruction({
        project: ctx.project,
        dataRepo: ctx.dataRepo,
        manifest: ctx.manifest,
        kind: parsed.kind,
        name: parsed.name,
        key: target.key,
        scope: target.scope,
        currentEntry,
        selectedEntry,
        reviewCommand,
      });
      changes.push(...planned.changes);
      snapshotParts.push(...planned.snapshotParts);
    } else if (
      isCopyTargetFileItemKind(parsed.kind) &&
      currentEntry.source === "data" &&
      selectedEntry.source === "data" &&
      ctx.dataRepo
    ) {
      const planned = await planSubagentDestruction({
        project: ctx.project,
        dataRepo: ctx.dataRepo,
        name: parsed.name,
        key: target.key,
        scope: target.scope,
        currentEntry,
        selectedEntry,
        reviewCommand,
      });
      changes.push(...planned.changes);
      snapshotParts.push(...planned.snapshotParts);
    }
  }

  if (fragmentTargets.size > 0 && ctx.dataRepo) {
    const plans: FragmentOutputPlan[] = [];
    for (const target of [...fragmentTargets].sort()) {
      try {
        plans.push(
          await planFragmentOutput({
            project: ctx.project,
            dataRepo: ctx.dataRepo,
            manifest: ctx.manifest,
            oldLock: projectLock,
            nextLock: fragmentNextLock,
            target,
          }),
        );
      } catch (error) {
        results.push({
          key: fragmentTargetKey(target),
          source: "data",
          kind: fragmentKindForTarget(target),
          name: "(merged)",
          action: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const result of await applyFragmentOutputPlans(plans, {
      dryRun: true,
    })) {
      if (result.action !== "already-current") {
        results.push(fragmentMergedUpdateResult(result));
      }
    }
    const contributionStates = new Map<
      FragmentTarget,
      Awaited<ReturnType<typeof fragmentContributionState>>
    >();
    const reviewCommands = new Map<FragmentTarget, string>();
    for (const target of fragmentTargets) {
      contributionStates.set(
        target,
        await fragmentContributionState(
          ctx.project,
          ctx.dataRepo,
          ctx.manifest,
          projectLock,
          target,
        ),
      );
      const refs = [...(fragmentItems.get(target) ?? [])].sort();
      if (refs.length > 0) {
        reviewCommands.set(target, `capshelf status ${refs.join(" ")} --diff`);
      }
    }
    const fragmentDestruction = planFragmentDestruction({
      project: ctx.project,
      plans,
      contributionStates,
      reviewCommands,
    });
    changes.push(...fragmentDestruction.changes);
    snapshotParts.push(...fragmentDestruction.snapshotParts);
  }

  return {
    results,
    destructivePlan: createDestructiveChangePlan(changes, snapshotParts),
  };
}

function lockEntrySnapshot(entry: LockEntry): string {
  const { appliedAt: _appliedAt, ...stable } = entry;
  return JSON.stringify(stable);
}

function itemReviewCommand(
  kind: string,
  name: string,
  scope: "project" | "local",
): string {
  return `capshelf status ${kind}/${name}${scope === "local" ? " --local" : ""} --diff`;
}

function updateRerunCommand(refs: string[], local: boolean): string {
  return `capshelf update${refs.length > 0 ? ` ${refs.join(" ")}` : ""}${local ? " --local" : ""} --yes`;
}

function printUpdateOutput(opts: {
  project: string;
  dataRepo: string | undefined;
  dryRun: boolean;
  results: UpdateResult[];
  destructivePlan: DestructiveChangePlan;
  json: boolean;
}): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          project: opts.project,
          dataRepo: opts.dataRepo,
          dryRun: opts.dryRun,
          items: opts.results,
          destructiveChanges: opts.destructivePlan.changes,
        },
        null,
        2,
      ),
    );
    return;
  }
  printUpdateResults(opts.results);
  printKeptLocalHint(opts.results);
  if (opts.dryRun && opts.destructivePlan.changes.length > 0) {
    console.log(
      renderDestructiveChanges("Update", opts.destructivePlan.changes),
    );
  }
}

interface FragmentContribution {
  key: string;
  entry: LockEntry;
  targets: FragmentTarget[];
  lockChanged: boolean;
}

interface TargetOutcome {
  result: UpdateResult;
  /** Lock entry to write into the target's scope when this is not a dry run. */
  newEntry?: LockEntry;
  /** Whether the pinned content changed (marks the scope's lock dirty). */
  changed?: boolean;
  /** Fragment items defer their lock write and reconcile after the loop. */
  fragment?: FragmentContribution;
}

async function updateOneTarget(
  ctx: UpdateContext,
  target: ScopedTarget,
  entry: LockEntry,
): Promise<TargetOutcome> {
  const { scope, key } = target;
  const parsed = parseLockKey(key);
  if (parsed.kind === "skills" && ctx.externalSkillByName.has(parsed.name)) {
    const message = skillsShConflictMessage(
      ctx.externalSkillByName.get(parsed.name)!,
    );
    // An explicit request to update a skills.sh-owned skill is refused; an
    // implicit sweep records the skip and continues.
    if (ctx.explicit) {
      throw new PreconditionError(
        `not updating skills/${parsed.name} — ${message}`,
      );
    }
    return {
      result: {
        key,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: "skipped-external",
        error: message,
      },
    };
  }
  try {
    return entry.source === "data"
      ? await updateDataTarget(ctx, scope, key, parsed, entry)
      : await updateSystemTarget(ctx, scope, key, parsed, entry);
  } catch (err) {
    return {
      result: {
        key,
        scope,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function updateDataTarget(
  ctx: UpdateContext,
  scope: "project" | "local",
  key: string,
  parsed: ReturnType<typeof parseLockKey>,
  entry: DataLockEntry,
): Promise<TargetOutcome> {
  if (scope === "local") {
    assertLocalScopeSupported(parsed.kind, parsed.name, "update --local");
  }
  if (entry.local === true) {
    const runtimeWarnings = runtimeWarningsForItem(
      ctx.project,
      parsed.kind,
      parsed.name,
    );
    return {
      result: {
        key,
        scope,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: "kept-local",
        sha: entry.sha,
        sourceCommit: entry.sourceCommit,
        ...(entry.localReason !== undefined && {
          localReason: entry.localReason,
        }),
        ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
      },
    };
  }
  if (!ctx.dataRepo) throw new Error("data repo is required");
  const item = await findMasterItemByRef(ctx.dataRepo, {
    kind: parsed.kind,
    name: parsed.name,
  });
  if (!item) {
    throw new Error(`missing upstream item: ${parsed.kind}/${parsed.name}`);
  }
  if (
    !isCopyDirectoryItemKind(parsed.kind) &&
    !isCopyTargetFileItemKind(parsed.kind) &&
    !isFragmentItemKind(parsed.kind)
  ) {
    throw new Error(`no update strategy for ${parsed.kind}/${parsed.name}`);
  }

  const sha = isFragmentItemKind(parsed.kind)
    ? await shaOfFragmentItem(ctx.dataRepo, parsed.kind, parsed.name)
    : parsed.kind === "subagents"
      ? await shaOfCurrentSubagent(ctx.project, ctx.dataRepo, parsed.name)
      : await shaOfGitVisibleItem(ctx.dataRepo, item.repoRelPath);
  const sourceCommit = isFragmentItemKind(parsed.kind)
    ? await lastTouchingFragmentCommit(ctx.dataRepo, parsed.kind, parsed.name)
    : parsed.kind === "subagents"
      ? await lastTouchingSubagentCommit(ctx.project, ctx.dataRepo, parsed.name)
      : await lastTouchingContentCommit(ctx.dataRepo, item.repoRelPath);
  const currentSnapshot = await captureCommittedItemNeeds(ctx.dataRepo, item);
  const lockedNeeds = entry.needs ?? null;
  const needsWouldChange =
    lockedNeeds === null || !needsEqual(lockedNeeds, currentSnapshot.needs);
  const snapshot = needsWouldChange
    ? currentSnapshot
    : {
        needs: entry.needs ?? currentSnapshot.needs,
        needsSourceCommit:
          entry.needsSourceCommit ?? currentSnapshot.needsSourceCommit,
      };
  const contentWouldChange =
    sha !== entry.sha || sourceCommit !== entry.sourceCommit;
  const lockWouldChange =
    contentWouldChange || needsWouldChange || entry.needsSourceCommit === null;
  const newEntry = refreshDataLockEntry(entry, {
    sha,
    sourceCommit,
    ...snapshot,
    ...(!lockWouldChange && { appliedAt: entry.appliedAt }),
  });
  const changedAction: UpdateAction | undefined = lockWouldChange
    ? ctx.dryRun
      ? "would-update"
      : "updated"
    : undefined;

  if (isFragmentItemKind(parsed.kind)) {
    if (scope === "local") {
      throw new PreconditionError(
        `--local is not supported for ${parsed.kind} fragments`,
      );
    }
    const targets = await touchedFragmentTargetsForItem(
      ctx.dataRepo,
      parsed.kind,
      parsed.name,
      entry,
      ctx.manifest,
    );
    return {
      result: {
        key,
        scope,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: changedAction ?? "already-current",
        sha,
        lockedSha: entry.sha,
        plannedSha: sha,
        sourceCommit,
        ...(ctx.dryRun && { dryRun: true as const }),
      },
      fragment: { key, entry: newEntry, targets, lockChanged: lockWouldChange },
    };
  }

  const installedSha = needsWouldChange
    ? parsed.kind === "subagents"
      ? await shaOfInstalledSubagent(
          ctx.project,
          ctx.dataRepo,
          parsed.name,
          entry.sourceCommit,
        )
      : await shaOfInstalled(ctx.project, parsed.kind, parsed.name)
    : null;
  const skipMaterialize =
    needsWouldChange && !contentWouldChange && installedSha === entry.sha;
  const materialized = skipMaterialize
    ? {
        action: "already-current" as const,
        currentSha: installedSha,
        runtimeWarnings: runtimeWarningsForItem(
          ctx.project,
          parsed.kind,
          parsed.name,
        ),
      }
    : parsed.kind === "subagents"
      ? await (async () => {
          const dataRepo = ctx.dataRepo;
          if (!dataRepo) throw new Error("data repo is required");
          const before = await shaOfInstalledSubagent(
            ctx.project,
            dataRepo,
            parsed.name,
            entry.sourceCommit,
          );
          const applied = await materializeSubagent({
            project: ctx.project,
            dataRepo,
            name: parsed.name,
            entry: newEntry,
            previousEntry: entry,
            dryRun: ctx.dryRun,
          });
          for (const warning of applied.warnings) {
            console.error(`⚠ ${warning}`);
          }
          return {
            action: ctx.dryRun
              ? applied.changed
                ? ("would-reconcile" as const)
                : ("already-current" as const)
              : applied.changed
                ? ("reconciled" as const)
                : ("already-current" as const),
            currentSha: before,
          };
        })()
      : await materializeLockEntry({
          project: ctx.project,
          dataRepo: ctx.dataRepo,
          manifest: ctx.manifest,
          key,
          entry: newEntry,
          previousEntry: entry,
          scope,
          dryRun: ctx.dryRun,
        });
  const runtimeWarnings = runtimeWarningsForItem(
    ctx.project,
    parsed.kind,
    parsed.name,
  );
  return {
    result: {
      key,
      scope,
      source: parsed.source,
      kind: parsed.kind,
      name: parsed.name,
      action: changedAction ?? materialized.action,
      sha,
      currentSha: materialized.currentSha,
      lockedSha: entry.sha,
      plannedSha: sha,
      sourceCommit,
      runtimeWarnings,
      ...(ctx.dryRun && { dryRun: true as const }),
    },
    newEntry,
    changed: lockWouldChange,
  };
}

async function updateSystemTarget(
  ctx: UpdateContext,
  scope: "project" | "local",
  key: string,
  parsed: ReturnType<typeof parseLockKey>,
  entry: SystemLockEntry,
): Promise<TargetOutcome> {
  const item = findSystemItem(parsed.name);
  if (!item || item.kind !== parsed.kind) {
    throw new Error(
      `system item no longer bundled: ${parsed.kind}/${parsed.name}`,
    );
  }
  const sha = await shaOfSystemItem(item);
  const lockWouldChange = sha !== entry.sha || entry.cliVersion !== CLI_VERSION;
  const newEntry: SystemLockEntry = {
    source: "system",
    sha,
    cliVersion: CLI_VERSION,
    appliedAt: lockWouldChange ? new Date().toISOString() : entry.appliedAt,
  };
  const materialized = await materializeLockEntry({
    project: ctx.project,
    key,
    manifest: ctx.manifest,
    entry: newEntry,
    previousEntry: entry,
    scope,
    dryRun: ctx.dryRun,
  });
  return {
    result: {
      key,
      scope,
      source: parsed.source,
      kind: parsed.kind,
      name: parsed.name,
      action: lockWouldChange
        ? ctx.dryRun
          ? "would-update"
          : "updated"
        : materialized.action,
      sha,
      currentSha: materialized.currentSha,
      lockedSha: entry.sha,
      plannedSha: sha,
      cliVersion: CLI_VERSION,
      runtimeWarnings: materialized.runtimeWarnings,
      ...(ctx.dryRun && { dryRun: true as const }),
    },
    newEntry,
    changed: lockWouldChange,
  };
}

function printUpdateResults(results: UpdateResult[]): void {
  if (results.length === 0) {
    console.log("(no items tracked)");
    return;
  }
  for (const r of results) {
    const id = `${r.scope ? `${r.scope}/` : ""}${r.source}/${r.kind}/${r.name}`;
    if (r.action === "error") {
      console.log(`✗ ${id} error`);
      console.log(`  ${r.error}`);
    } else if (r.action === "skipped-external") {
      console.log(`• ${id} skipped`);
      console.log(`  ${r.error}`);
    } else if (r.action === "would-update") {
      console.log(`• ${id} would update`);
      printUpdateDetails(r);
    } else if (r.action === "would-reconcile") {
      console.log(`• ${id} would reconcile`);
      printUpdateDetails(r);
    } else {
      console.log(`✓ ${id} ${r.action}`);
      if (r.action === "kept-local" && r.localReason) {
        console.log(`  ${r.localReason}`);
      }
      printUpdateDetails(r);
    }
  }
}

/**
 * Once per run, not per item. The marker is cleared by exactly one command, so
 * a run that skipped items has to name it — and a project with several marked
 * items should not repeat the same line for each.
 */
function printKeptLocalHint(results: UpdateResult[]): void {
  const first = results.find((result) => result.action === "kept-local");
  if (!first) return;
  console.log(
    `  clear a keep-local marker to have it reconciled again: ${PRODUCT_NAME} keep-local ${first.kind}/${first.name}${
      first.scope === "local" ? " --local" : ""
    } --unset`,
  );
}

function printUpdateDetails(r: UpdateResult): void {
  if (r.currentSha !== undefined) {
    console.log(`  current: ${r.currentSha ?? "(missing)"}`);
  }
  if (r.lockedSha) console.log(`  locked: ${r.lockedSha}`);
  if (r.plannedSha) console.log(`  planned: ${r.plannedSha}`);
  if (r.sourceCommit) console.log(`  source commit: ${r.sourceCommit}`);
  if (r.cliVersion) console.log(`  cli version: ${r.cliVersion}`);
  printRuntimeWarnings(r.runtimeWarnings);
}

function fragmentMergedUpdateResult(result: FragmentApplyResult): UpdateResult {
  const kind = fragmentKindForTarget(result.target);
  return {
    key: result.key,
    source: "data",
    kind,
    name: "(merged)",
    action: result.action,
    currentSha: result.currentSha,
    plannedSha: result.plannedSha,
    ...(result.dryRun && { dryRun: true as const }),
  };
}
