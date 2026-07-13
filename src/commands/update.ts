import type { Command } from "commander";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { loadLocalLock, loadLock, saveLocalLock, saveLock } from "../lock";
import type { DataLockEntry, LockEntry, SystemLockEntry } from "../lock";
import { parseLockKey } from "../installed";
import { isFragmentItemKind, shaOfGitVisibleItem } from "../master";
import {
  assertIsGitRepo,
  assertRepoClean,
  lastTouchingContentCommit,
} from "../git";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../global-options";
import { PreconditionError, ResultExitError } from "../errors";
import { findMasterItemByRef } from "../item-ref";
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
  applyFragmentOutput,
  fragmentKindForTarget,
  fragmentTargetKey,
  lastTouchingFragmentCommit,
  shaOfFragmentItem,
  touchedFragmentTargetsForItem,
  type FragmentApplyResult,
  type FragmentTarget,
} from "../fragments";

interface UpdateOptions {
  json?: boolean;
  dryRun?: boolean;
  local?: boolean;
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
    .option("--json", "output JSON")
    .action(
      async (
        itemRefs: string[] | undefined,
        opts: UpdateOptions,
        cmd: Command,
      ) => {
        const project = projectRoot();
        const manifest = await loadManifest(project);
        const projectLock = await loadLock(project);
        const localLock = await loadLocalLock(project);
        const refs = itemRefs ?? [];
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
          ? await resolveDataRepo({
              override: globalOpts(cmd).data,
              manifest,
              project,
            })
          : undefined;
        if (dataRepo) {
          await assertIsGitRepo(dataRepo);
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
          for (const target of touchedFragmentTargets) {
            try {
              const applied = await applyFragmentOutput({
                project,
                dataRepo,
                manifest,
                oldLock: originalLock,
                nextLock: fragmentNextLock,
                target,
                dryRun: opts.dryRun,
              });
              if (applied.action !== "already-current") {
                results.push(fragmentMergedUpdateResult(applied));
              }
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
          if (!opts.dryRun && !reconcileFailed) {
            for (const [key, entry] of pendingFragmentEntries) {
              projectLock.items[key] = entry;
            }
            projectChanged = projectChanged || fragmentLockChanged;
          }
        }

        if (projectChanged) await saveLock(project, projectLock);
        if (localChanged) await saveLocalLock(project, localLock);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                project,
                dataRepo,
                dryRun: opts.dryRun === true,
                items: results,
              },
              null,
              2,
            ),
          );
        } else {
          printUpdateResults(results);
        }
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

  const sha = isFragmentItemKind(parsed.kind)
    ? await shaOfFragmentItem(ctx.dataRepo, parsed.kind, parsed.name)
    : await shaOfGitVisibleItem(ctx.dataRepo, item.repoRelPath);
  const sourceCommit = isFragmentItemKind(parsed.kind)
    ? await lastTouchingFragmentCommit(ctx.dataRepo, parsed.kind, parsed.name)
    : await lastTouchingContentCommit(ctx.dataRepo, item.repoRelPath);
  const lockWouldChange =
    sha !== entry.sha || sourceCommit !== entry.sourceCommit;
  const newEntry: DataLockEntry = {
    ...entry,
    sha,
    sourceCommit,
    appliedAt: lockWouldChange ? new Date().toISOString() : entry.appliedAt,
  };
  const changedAction: UpdateAction | undefined = lockWouldChange
    ? ctx.dryRun
      ? "would-update"
      : "updated"
    : undefined;

  if (isFragmentItemKind(parsed.kind)) {
    if (scope === "local") {
      throw new Error(`--local is not supported for ${parsed.kind} fragments`);
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

  const materialized = await materializeLockEntry({
    project: ctx.project,
    dataRepo: ctx.dataRepo,
    manifest: ctx.manifest,
    key,
    entry: newEntry,
    dryRun: ctx.dryRun,
  });
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
      runtimeWarnings: materialized.runtimeWarnings,
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
      printUpdateDetails(r);
    }
  }
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
