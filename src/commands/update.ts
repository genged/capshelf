import type { Command } from "commander";
import { GitReadMemo } from "../git-read-memo";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  confirmationContext,
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
  assertLockV4,
  entryIdentity,
  loadLocalLock,
  loadLock,
  needsEqual,
  refreshDataLockEntry,
  saveLocalLock,
  saveLock,
} from "../lock";
import {
  assertNoDestinationCollisions,
  pinCurrentSource,
  shortIdentity,
  blobIdOf,
  hashWidthOf,
  itemTreeEntriesAtCommit,
  sourcePinDigest,
} from "../pin";
import type {
  DataLockEntryV4,
  LockEntry,
  LockEntryV4,
  LockV4,
  SystemLockEntry,
} from "../lock";
import { installedPath, parseLockKey, shaOfInstalled } from "../installed";
import {
  contentSourceFor,
  contentSourceOrNull,
  gitTreeSource,
} from "../item-source";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  isFragmentKindName,
  itemRepoRelPath,
} from "../master";
import {
  assertRepoClean,
  commitExists,
  headSha,
  isAncestor,
  objectTypeAtCommit,
  resolveCommit,
} from "../git";
import { PRODUCT_NAME } from "../identity";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { PreconditionError, ResultExitError } from "../errors";
import { assertLocalScopeSupported } from "../local-config";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { resolveTrackedTarget } from "../targets";
import type { ScopedTarget } from "../targets";
import {
  assertNoPreservedPathCollisions,
  copyDirectoryReconciliationFiles,
  materializeLockEntry,
} from "../materialize";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "../external";
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
  planFragmentOutput,
  touchedFragmentTargetsForItem,
  type FragmentApplyResult,
  type FragmentOutputPlan,
  type FragmentTarget,
} from "../fragments";
import { captureCommittedItemNeeds } from "../metadata";
import { materializeSubagent, shaOfInstalledSubagent } from "../subagents";
import {
  installedSnapshot,
  namedFilesAtCommit,
  namedFilesFromInstalledSnapshot,
  sidecarFromInstalledSnapshot,
} from "../item-snapshot";
import { mergeNamedTrees, namedFilesEqual } from "../merge-tree";
import { beginInstalledReconciliation } from "../promote-transaction";
import { remoteCacheState } from "../remote-cache";
import { remoteTreeSource } from "../remote-discovery";
import {
  previewRemoteUpdate,
  remoteEntryAsDataEntry,
  updateMergeRemoteTarget,
  updateRemoteSkill,
} from "../remote-item";
import {
  REMOTE_ITEM_KIND,
  loadRemotesLock,
  parseRemoteKey,
  remoteKey,
  remoteKeysForRef,
  saveRemotesLock,
} from "../remotes-lock";
import type { RemoteLockEntry, RemotesLock } from "../remotes-lock";

interface UpdateOptions {
  json?: boolean;
  dryRun?: boolean;
  local?: boolean;
  yes?: boolean;
  merge?: boolean;
}

type UpdateAction =
  | "updated"
  | "skipped"
  | "would-update"
  | "already-current"
  | "reconciled"
  | "would-reconcile"
  | "kept-local"
  | "skipped-external"
  | "error"
  | "merged"
  | "would-merge";

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
  merged?: true;
  mergeResultSha?: string;
  mergeBase?: string;
  mergedUpstreamCommit?: string;
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
    .option(
      "--merge",
      "merge local and newer upstream content into the installed copy",
    )
    .option("--json", "output JSON")
    .action(
      async (
        itemRefs: string[] | undefined,
        opts: UpdateOptions,
        cmd: Command,
      ) => {
        const refs = itemRefs ?? [];
        if (opts.merge && refs.length !== 1) {
          throw new PreconditionError(
            "update --merge requires exactly one explicit item",
          );
        }
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
        // A remote row is in neither capshelf lock by A3, so it is resolved
        // here rather than by `resolveTrackedTarget`: widening that resolver
        // would change the return type for `apply` and `status` at once.
        const remotes = await loadRemotesLock(project);
        const remoteTargets = resolveRemoteTargets(remotes, refs);
        const remoteNames = new Set(remoteTargets.map((target) => target.name));
        const shelfRefs = refs.filter(
          (itemRef) => !remoteNames.has(parseItemRef(itemRef).name),
        );
        // `--merge` preserves the local edit for a shelf item, so `--yes` has
        // nothing to authorize and the pair is refused. For a remote row
        // `--yes` answers A9's new-content prompt, which `--merge` still asks.
        if (opts.merge && opts.yes && remoteTargets.length === 0) {
          throw new PreconditionError(
            "--merge and --yes cannot be used together",
          );
        }
        // PIN-12: no ordinary lock write migrates. `update` reads either
        // version but writes only version 4, so it refuses here with the
        // migration command rather than rewriting entries as a side effect.
        const writableProjectLock = assertLockV4(
          projectLock,
          "capshelf update",
        );
        const writableLocalLock = assertLockV4(localLock, "capshelf update");
        const explicit = refs.length > 0;

        const targets: ScopedTarget[] = [];
        if (refs.length > 0) {
          for (const itemRef of shelfRefs) {
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

        if (opts.merge && remoteTargets.length === 1) {
          const outcome = await runRemoteUpdates({
            project,
            manifest,
            targets: remoteTargets,
            remotes,
            merge: true,
            dryRun: opts.dryRun === true,
            json: opts.json === true,
            yes: opts.yes === true,
          });
          printUpdateOutput({
            project,
            dataRepo: undefined,
            dryRun: opts.dryRun === true,
            results: outcome.results,
            destructivePlan: createDestructiveChangePlan([], []),
            json: opts.json === true,
          });
          if (!opts.json) printRemoteAdoptGuidance(outcome.results);
          return;
        }
        if (opts.merge) {
          if (!dataRepo) throw new PreconditionError("data repo is required");
          const result = await updateMergeTarget({
            project,
            manifest,
            dataRepo,
            target: targets[0]!,
            projectLock: writableProjectLock,
            localLock: writableLocalLock,
            dryRun: opts.dryRun === true,
          });
          printUpdateOutput({
            project,
            dataRepo,
            dryRun: opts.dryRun === true,
            results: [result],
            destructivePlan: createDestructiveChangePlan([], []),
            json: opts.json === true,
          });
          return;
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
        const pendingFragmentEntries = new Map<string, LockEntryV4>();
        const touchedFragmentTargets = new Set<FragmentTarget>();
        let fragmentLockChanged = false;

        const ctx: UpdateContext = {
          memo: new GitReadMemo(),
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
          writableProjectLock,
          writableLocalLock,
        );
        if (opts.dryRun) {
          // Remote rows preview here too. Without this a dry run on a pulled
          // skill prints "(no items tracked)" and exits 0 while the real run
          // would move the pin and rewrite files, so the preview would
          // disagree with the command it previews.
          const dryRemote = await runRemoteUpdates({
            project,
            manifest,
            targets: remoteTargets,
            remotes,
            merge: false,
            dryRun: true,
            json: opts.json === true,
            yes: opts.yes === true,
          });
          const dryResults = [...preflight.results, ...dryRemote.results];
          printUpdateOutput({
            project,
            dataRepo,
            dryRun: true,
            results: dryResults,
            destructivePlan: preflight.destructivePlan,
            json: opts.json === true,
          });
          if (dryResults.some((result) => result.action === "error")) {
            throw new ResultExitError(1);
          }
          return;
        }
        // Scoped to fragment targets: they share output files and can leave
        // the runtime diverged from the lock, so a partial write is worse
        // than no write. Independent copy and subagent items fall through to
        // per-item handling, converging everything they can.
        const fragmentPreflightFailed = preflight.results.some(
          (result) =>
            result.action === "error" && isFragmentKindName(result.kind),
        );
        if (fragmentPreflightFailed) {
          printUpdateOutput({
            project,
            dataRepo,
            dryRun: false,
            results: preflight.results.filter(
              (result) => result.action === "error",
            ),
            destructivePlan: preflight.destructivePlan,
            json: opts.json === true,
          });
          if (!opts.json) {
            console.log(
              "  no changes were written; fragment outputs are reconciled together",
            );
          }
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
          writableProjectLock,
          writableLocalLock,
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
          const lock =
            scope === "local" ? writableLocalLock : writableProjectLock;
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
                  memo: ctx.memo,
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
              writableProjectLock.items[key] = entry;
            }
            projectChanged = projectChanged || fragmentLockChanged;
          }
        }

        // Remote rows run after the shelf pass and never share its lock, so a
        // failure in either population leaves the other converged.
        const remoteOutcome = await runRemoteUpdates({
          project,
          manifest,
          targets: remoteTargets,
          remotes,
          merge: false,
          // The dry-run path returned above, so this pass always writes.
          dryRun: false,
          json: opts.json === true,
          yes: opts.yes === true,
        });
        results.push(...remoteOutcome.results);

        if (projectChanged) await saveLock(project, writableProjectLock);
        if (localChanged) await saveLocalLock(project, writableLocalLock);

        printUpdateOutput({
          project,
          dataRepo,
          dryRun: false,
          results,
          destructivePlan: preflight.destructivePlan,
          json: opts.json === true,
        });
        if (!opts.json) {
          printRemoteAdoptGuidance(remoteOutcome.results);
          printRemoteSkipHint(remoteOutcome.results);
        }
        if (results.some((r) => r.action === "error")) {
          throw new ResultExitError(1);
        }
      },
    );
}

interface RemoteTarget {
  name: string;
  key: string;
  /**
   * Load-bearing, not bookkeeping. A9 forbids a bare sweep from moving a
   * remote pin, and the enumeration below deliberately still lists every row
   * so the sweep can report it. This flag is what stops them at the gate.
   */
  named: boolean;
}

function resolveRemoteTargets(
  remotes: RemotesLock,
  refs: string[],
): RemoteTarget[] {
  if (refs.length > 0) {
    return refs.flatMap((itemRef) =>
      remoteKeysForRef(remotes, parseItemRef(itemRef)).map((key) => ({
        key,
        name: parseRemoteKey(key).name,
        named: true,
      })),
    );
  }
  return Object.keys(remotes.items).map((key) => ({
    key,
    name: parseRemoteKey(key).name,
    named: false,
  }));
}

interface RemoteUpdateOutcome {
  results: UpdateResult[];
}

/**
 * The remote half of `update`.
 *
 * Consent lives here rather than in `updateRemoteSkill`: that function sees no
 * `--yes`, no `--json`, and no terminal state, so it cannot decide anything.
 * Keeping the prompt in the command is also what lets a bare sweep return
 * `skipped` without ever entering the write path.
 */
async function runRemoteUpdates(input: {
  project: string;
  manifest: Manifest;
  targets: RemoteTarget[];
  remotes: RemotesLock;
  merge: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
}): Promise<RemoteUpdateOutcome> {
  const results: UpdateResult[] = [];
  for (const target of input.targets) {
    const entry = input.remotes.items[target.key]!;
    if (!target.named) {
      // A9. A routine sweep across a project must not become interactive, and
      // it must not move a pin the user has not reviewed either.
      results.push(remoteResult(target, "skipped", entry, entry.sourceCommit));
      continue;
    }
    const preview = await previewRemoteUpdate({
      project: input.project,
      name: target.name,
      entry,
    });
    if (preview.current) {
      results.push(
        remoteResult(target, "already-current", entry, preview.to, entry),
      );
      continue;
    }
    if (
      !(await confirmRemotePinMove({
        project: input.project,
        manifest: input.manifest,
        name: target.name,
        entry,
        preview,
        dryRun: input.dryRun,
        json: input.json,
        yes: input.yes,
      }))
    ) {
      return { results };
    }
    const moved = input.merge
      ? await updateMergeRemoteTarget({
          project: input.project,
          name: target.name,
          entry,
          preview,
          dryRun: input.dryRun,
        })
      : await updateRemoteSkill({
          project: input.project,
          name: target.name,
          entry,
          preview,
          dryRun: input.dryRun,
        });
    results.push(
      remoteResult(target, moved.action, entry, moved.to, moved.entry),
    );
    if (!input.dryRun && moved.action === "updated") {
      input.remotes.items[target.key] = moved.entry;
      // Before the next row can refuse the command. `reconcileRemoteSkill`
      // already rewrote this row's files, so a save deferred to the end of the
      // run would leave them holding content the pin does not name — reported
      // as drift the user never introduced.
      await saveRemotesLock(input.project, input.remotes);
    }
  }
  return { results };
}

/**
 * A9's gate, and the drift gate, in one prompt.
 *
 * The new content is the thing consent covers, and the loss of a local edit is
 * part of the same write. Asking twice would make `--yes` mean two different
 * answers; the block below states both facts and the planner supplies the
 * loss list, so the accounting is the real one.
 */
async function confirmRemotePinMove(input: {
  project: string;
  manifest: Manifest;
  name: string;
  entry: RemoteLockEntry;
  preview: Awaited<ReturnType<typeof previewRemoteUpdate>>;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
}): Promise<boolean> {
  if (input.dryRun || input.yes) return true;
  const destruction = await planRemotePinMove(input);
  const block = [
    `  pinned    ${input.preview.from.slice(0, 7)}  ->  ${input.preview.to.slice(0, 7)}   (from the local cache, no network)`,
    `  files     ${input.preview.changed.length} changed`,
    ...input.preview.changed.map((path) => `              ${path}`),
    ...(destruction.changes.length > 0
      ? ["", renderDestructiveChanges("Update", destruction.changes)]
      : []),
    "",
    "  capshelf does not review this content. Your agent runs it with your permissions.",
  ].join("\n");
  const context = confirmationContext();
  if (input.json || !context.stdinIsTTY || !context.stderrIsTTY) {
    throw new PreconditionError(
      `not moving ${remoteKey(input.name)} to ${input.preview.to.slice(0, 7)} without consent — it is content from a repository outside your shelf`,
      {
        hint: `review it, then authorize with --yes: ${PRODUCT_NAME} update ${REMOTE_ITEM_KIND}/${input.name} --yes`,
      },
    );
  }
  const answer = await context.prompt(`${block}\nMove the pin? [y/N] `);
  if (/^(y|yes)$/i.test(answer.trim())) return true;
  context.stderr.write("Update cancelled; no changes were written.\n");
  return false;
}

/** What the pin move would destroy, through the planner every write uses. */
async function planRemotePinMove(input: {
  project: string;
  manifest: Manifest;
  name: string;
  entry: RemoteLockEntry;
  preview: Awaited<ReturnType<typeof previewRemoteUpdate>>;
}): Promise<{ changes: DestructiveChange[] }> {
  const pin = input.preview.pin;
  if (pin === null) return { changes: [] };
  const cache = remoteCacheState(input.entry.upstream);
  const current = remoteTreeSource(
    cache.path,
    input.entry.sourceCommit,
    input.entry.subpath,
  );
  const selected = remoteTreeSource(
    cache.path,
    pin.sourceCommit,
    input.entry.subpath,
  );
  const next: RemoteLockEntry = {
    ...input.entry,
    sourceCommit: pin.sourceCommit,
    sourcePinDigest: pin.sourcePinDigest,
  };
  return await planCopyDirectoryDestruction({
    project: input.project,
    currentSource: current,
    selectedSource: selected,
    manifest: input.manifest,
    kind: REMOTE_ITEM_KIND,
    name: input.name,
    key: remoteKey(input.name),
    scope: "local",
    currentEntry: remoteEntryAsDataEntry(input.entry),
    selectedEntry: remoteEntryAsDataEntry(next),
    reviewCommand: `${PRODUCT_NAME} status ${REMOTE_ITEM_KIND}/${input.name} --diff-view installed`,
    repairUnresolvableCurrent: true,
  });
}

function remoteResult(
  target: RemoteTarget,
  action: UpdateAction,
  entry: RemoteLockEntry,
  to: string,
  next?: RemoteLockEntry,
): UpdateResult {
  return {
    key: target.key,
    scope: "local",
    source: "remote",
    kind: REMOTE_ITEM_KIND,
    name: target.name,
    action,
    sha: next?.sourcePinDigest ?? entry.sourcePinDigest,
    lockedSha: entry.sourcePinDigest,
    plannedSha: next?.sourcePinDigest ?? entry.sourcePinDigest,
    sourceCommit: to,
  };
}

/** A pulled skill has nowhere to promote to, so its next step is the adopt. */
function printRemoteAdoptGuidance(results: UpdateResult[]): void {
  for (const result of results) {
    if (result.source !== "remote") continue;
    if (result.action !== "updated" && result.action !== "merged") continue;
    console.log(
      `  promote is not available for a pulled skill. to keep it permanently: ${PRODUCT_NAME} share ${result.kind}/${result.name} --adopt`,
    );
  }
}

/** Once per run: a bare sweep names the command that would move these pins. */
function printRemoteSkipHint(results: UpdateResult[]): void {
  const skipped = results.filter(
    (result) => result.source === "remote" && result.action === "skipped",
  );
  if (skipped.length === 0) return;
  console.log(
    `  ${skipped.length} pulled ${skipped.length === 1 ? "skill was" : "skills were"} left alone; a sweep never accepts new third-party content`,
  );
  console.log(
    `  move one: ${PRODUCT_NAME} update ${skipped[0]!.kind}/${skipped[0]!.name}`,
  );
  console.log(
    `  no network was used. check for newer upstreams: ${PRODUCT_NAME} status --check-upstream`,
  );
}

async function updateMergeTarget(input: {
  project: string;
  manifest: Manifest;
  dataRepo: string;
  target: ScopedTarget;
  projectLock: LockV4;
  localLock: LockV4;
  dryRun: boolean;
}): Promise<UpdateResult> {
  const { project, dataRepo, target, dryRun } = input;
  const lock = target.scope === "local" ? input.localLock : input.projectLock;
  const entry = lock.items[target.key];
  const parsed = parseLockKey(target.key);
  const scopeFlag = target.scope === "local" ? " --local" : "";
  if (entry?.source !== "data") {
    throw new PreconditionError(
      "update --merge requires a version 4 data lock entry",
    );
  }
  await assertUpdateMergeNotSkillsShOwned(project, parsed.kind, parsed.name);
  if (entry.local === true) {
    throw new PreconditionError(
      `not updating ${parsed.kind}/${parsed.name} --merge — marked as intentional project-local divergence\n` +
        `  clear the marker first:\n    ${PRODUCT_NAME} keep-local ${parsed.kind}/${parsed.name}${scopeFlag} --unset`,
    );
  }
  if (!isCopyDirectoryItemKind(parsed.kind)) {
    throw new PreconditionError(
      `update --merge supports only skills and pi-extensions; ${parsed.kind}/${parsed.name} is not supported`,
    );
  }
  const kind = parsed.kind;
  if (target.scope === "local") {
    assertLocalScopeSupported(
      parsed.kind,
      parsed.name,
      "update --merge --local",
    );
  }

  await assertRepoClean(dataRepo);
  const repoRelPath = itemRepoRelPath(parsed.kind, parsed.name);
  const plannedHead = await headSha(dataRepo);
  const upstreamPin = await pinCurrentSource(
    dataRepo,
    parsed.kind,
    parsed.name,
  );
  const item = await findMasterItemByRef(dataRepo, {
    kind: parsed.kind,
    name: parsed.name,
  });
  if (!item) {
    throw new PreconditionError(
      `missing upstream item: ${parsed.kind}/${parsed.name}`,
    );
  }
  const needsSnapshot = await captureCommittedItemNeeds(dataRepo, item);
  const snapshot = await installedSnapshot(
    project,
    parsed.kind,
    parsed.name,
    target.scope,
  );
  if (snapshot === null) {
    throw new PreconditionError(
      `installed item is missing: ${installedPath(project, parsed.kind, parsed.name)}`,
    );
  }
  const [localFiles, localSidecar, upstreamFiles] = await Promise.all([
    namedFilesFromInstalledSnapshot(snapshot),
    sidecarFromInstalledSnapshot(snapshot),
    namedFilesAtCommit(dataRepo, repoRelPath, plannedHead),
  ]);
  const upstreamEntries = await itemTreeEntriesAtCommit(
    gitTreeSource({
      repo: dataRepo,
      kind: parsed.kind,
      name: parsed.name,
      commit: plannedHead,
    }),
    parsed.kind,
  );
  const hashWidth = hashWidthOf(upstreamEntries);
  const upstreamChanged = upstreamPin.sourcePinDigest !== entry.sourcePinDigest;
  const localSha = namedFilesPinDigest(localFiles, hashWidth);
  const localChanged = localSha !== entry.sourcePinDigest;

  let mergeBase = entry.sourceCommit;
  let resultFiles = upstreamFiles;
  let performedMerge = false;
  if (localChanged && upstreamChanged) {
    const resolvedBase = await resolveCommit(dataRepo, entry.sourceCommit);
    if (resolvedBase === null) {
      throw mergeUpdateProvenanceError(
        parsed.kind,
        parsed.name,
        "the locked source commit is not available in the data repo",
      );
    }
    mergeBase = resolvedBase;
    if (!(await isAncestor(dataRepo, mergeBase, plannedHead))) {
      throw mergeUpdateProvenanceError(
        parsed.kind,
        parsed.name,
        "the locked source commit is not an ancestor of data-repo HEAD",
      );
    }
    if (
      (await objectTypeAtCommit(dataRepo, mergeBase, repoRelPath)) !== "tree"
    ) {
      throw mergeUpdateProvenanceError(
        parsed.kind,
        parsed.name,
        "the locked source commit does not contain the item directory",
      );
    }
    const baseFiles = await namedFilesAtCommit(
      dataRepo,
      repoRelPath,
      mergeBase,
    );
    const baseEntries = await itemTreeEntriesAtCommit(
      gitTreeSource({
        repo: dataRepo,
        kind: parsed.kind,
        name: parsed.name,
        commit: mergeBase,
      }),
      parsed.kind,
    );
    if (sourcePinDigest(baseEntries) !== entry.sourcePinDigest) {
      throw mergeUpdateProvenanceError(
        parsed.kind,
        parsed.name,
        "the locked source commit does not reproduce the locked item content",
      );
    }
    const merged = await mergeNamedTrees(baseFiles, localFiles, upstreamFiles);
    if (!merged.ok) {
      throw new PreconditionError(
        `automatic merge conflicts in ${parsed.kind}/${parsed.name}; nothing changed.\n\n` +
          `  conflicting paths:\n${merged.conflicts.map((path) => `    ${path}`).join("\n")}`,
      );
    }
    resultFiles = merged.files;
    performedMerge = !namedFilesEqual(resultFiles, upstreamFiles);
  } else if (localChanged && !upstreamChanged) {
    resultFiles = localFiles;
  }

  const newEntry = refreshDataLockEntry(entry, {
    pin: upstreamPin,
    ...needsSnapshot,
  });
  const lockChanged = JSON.stringify(entry) !== JSON.stringify(newEntry);
  const filesChanged = !namedFilesEqual(localFiles, resultFiles);
  const mergeResultSha = namedFilesPinDigest(resultFiles, hashWidth);
  const action: UpdateAction = performedMerge
    ? dryRun
      ? "would-merge"
      : "merged"
    : lockChanged || filesChanged
      ? dryRun
        ? "would-update"
        : "updated"
      : "already-current";

  if (filesChanged) {
    await assertNoDestinationCollisions(
      `${parsed.kind}/${parsed.name}`,
      snapshot.localPath,
      resultFiles.map((file) => file.path),
    );
    const reconciliation = await copyDirectoryReconciliationFiles({
      project,
      source: contentSourceFor({
        entry: newEntry,
        kind,
        name: parsed.name,
        repo: dataRepo,
      }),
      manifest: input.manifest,
      kind,
      name: parsed.name,
      entry: newEntry,
      previous: {
        entry,
        source: contentSourceFor({
          entry,
          kind,
          name: parsed.name,
          repo: dataRepo,
        }),
      },
      scope: target.scope,
    });
    await assertNoPreservedPathCollisions({
      destination: snapshot.localPath,
      preserved: reconciliation.preserved,
      expected: resultFiles,
      kind,
      name: parsed.name,
    });
  }

  if (!dryRun && (lockChanged || filesChanged)) {
    await revalidateUpdateMergeInputs({
      ...input,
      entry,
      parsed: { ...parsed, kind },
      plannedHead,
      upstreamPin,
      needsSnapshot,
      localFiles,
      localSidecar,
    });
    const transaction = filesChanged
      ? await beginInstalledReconciliation(
          snapshot.localPath,
          localFiles,
          resultFiles,
        )
      : null;
    const previous = lock.items[target.key];
    lock.items[target.key] = newEntry;
    try {
      if (target.scope === "local")
        await saveLocalLock(project, input.localLock);
      else await saveLock(project, input.projectLock);
      await transaction?.commit();
    } catch (error) {
      if (previous) lock.items[target.key] = previous;
      await transaction?.rollback();
      throw error;
    }
  }

  return {
    key: target.key,
    scope: target.scope,
    source: parsed.source,
    kind: parsed.kind,
    name: parsed.name,
    action,
    sha: upstreamPin.sourcePinDigest,
    currentSha: localSha,
    lockedSha: entry.sourcePinDigest,
    plannedSha: upstreamPin.sourcePinDigest,
    sourceCommit: upstreamPin.sourceCommit,
    ...(dryRun && { dryRun: true as const }),
    ...(performedMerge && {
      merged: true as const,
      mergeResultSha,
      mergeBase,
      mergedUpstreamCommit: plannedHead,
    }),
    runtimeWarnings: runtimeWarningsForItem(project, parsed.kind, parsed.name),
  };
}

async function revalidateUpdateMergeInputs(input: {
  project: string;
  dataRepo: string;
  target: ScopedTarget;
  projectLock: LockV4;
  localLock: LockV4;
  entry: DataLockEntryV4;
  parsed: ReturnType<typeof parseLockKey> & {
    kind: "skills" | "pi-extensions";
  };
  plannedHead: string;
  upstreamPin: Awaited<ReturnType<typeof pinCurrentSource>>;
  needsSnapshot: Awaited<ReturnType<typeof captureCommittedItemNeeds>>;
  localFiles: Awaited<ReturnType<typeof namedFilesFromInstalledSnapshot>>;
  localSidecar: Buffer | null;
}): Promise<void> {
  await assertUpdateMergeNotSkillsShOwned(
    input.project,
    input.parsed.kind,
    input.parsed.name,
  );
  await assertRepoClean(input.dataRepo);
  const persistedLock =
    input.target.scope === "local"
      ? await loadLocalLock(input.project)
      : await loadLock(input.project);
  const currentLock = persistedLock.items[input.target.key];
  const currentSnapshot = await installedSnapshot(
    input.project,
    input.parsed.kind,
    input.parsed.name,
    input.target.scope,
  );
  const currentPin = await pinCurrentSource(
    input.dataRepo,
    input.parsed.kind,
    input.parsed.name,
  );
  const currentItem = await findMasterItemByRef(input.dataRepo, {
    kind: input.parsed.kind,
    name: input.parsed.name,
  });
  const currentNeeds = currentItem
    ? await captureCommittedItemNeeds(input.dataRepo, currentItem)
    : null;
  if (
    (await headSha(input.dataRepo)) !== input.plannedHead ||
    JSON.stringify(currentLock) !== JSON.stringify(input.entry) ||
    currentSnapshot === null ||
    !namedFilesEqual(
      await namedFilesFromInstalledSnapshot(currentSnapshot),
      input.localFiles,
    ) ||
    !bufferOrNullEqual(
      await sidecarFromInstalledSnapshot(currentSnapshot),
      input.localSidecar,
    ) ||
    currentPin.sourcePinDigest !== input.upstreamPin.sourcePinDigest ||
    currentPin.sourceCommit !== input.upstreamPin.sourceCommit ||
    JSON.stringify(currentNeeds) !== JSON.stringify(input.needsSnapshot)
  ) {
    throw new PreconditionError(
      `${input.parsed.kind}/${input.parsed.name} changed while preparing the merge; nothing was written. Rerun update --merge.`,
    );
  }
}

async function assertUpdateMergeNotSkillsShOwned(
  project: string,
  kind: string,
  name: string,
): Promise<void> {
  if (kind !== "skills") return;
  const external = await findSkillsShSkill(project, name);
  if (!external) return;
  throw new PreconditionError(
    `not updating skills/${name} — ${skillsShConflictMessage(external)}`,
  );
}

function bufferOrNullEqual(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}

function namedFilesPinDigest(
  files: Awaited<ReturnType<typeof namedFilesFromInstalledSnapshot>>,
  width: 40 | 64,
): string {
  return sourcePinDigest(
    files.map((file) => ({
      path: file.path,
      mode: file.mode,
      blobId: blobIdOf(file.content, width),
      repoRelPath: file.path,
    })),
  );
}

function mergeUpdateProvenanceError(
  kind: string,
  name: string,
  reason: string,
): PreconditionError {
  return new PreconditionError(
    `cannot merge ${kind}/${name}: ${reason}; nothing changed`,
  );
}

interface UpdateContext {
  memo: GitReadMemo;
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
  projectLock: LockV4,
  localLock: LockV4,
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
    // A planner failure is this item's failure, not the run's. Before PIN-8 an
    // unresolvable pin threw straight through `planUpdatePreflight` to the CLI
    // boundary, so one wedged item stopped every healthy item in the project
    // from being written.
    try {
      if (isCopyDirectoryItemKind(parsed.kind)) {
        const planned = await planCopyDirectoryDestruction({
          project: ctx.project,
          currentSource: contentSourceOrNull({
            entry: currentEntry,
            kind: parsed.kind,
            name: parsed.name,
            repo: ctx.dataRepo,
          }),
          selectedSource: contentSourceOrNull({
            entry: selectedEntry,
            kind: parsed.kind,
            name: parsed.name,
            repo: ctx.dataRepo,
          }),
          manifest: ctx.manifest,
          kind: parsed.kind,
          name: parsed.name,
          key: target.key,
          scope: target.scope,
          currentEntry,
          selectedEntry,
          reviewCommand,
          repairUnresolvableCurrent: true,
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
          repairUnresolvableCurrent: true,
        });
        changes.push(...planned.changes);
        snapshotParts.push(...planned.snapshotParts);
      }
    } catch (error) {
      const failed = results.findIndex(
        (result) => result.key === target.key && result.scope === target.scope,
      );
      const errorResult: UpdateResult = {
        key: target.key,
        scope: target.scope,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      if (failed === -1) results.push(errorResult);
      else results[failed] = errorResult;
      snapshotParts.push(
        `update-plan-error:${target.scope}:${target.key}:${errorResult.error}`,
      );
    }
  }

  if (fragmentTargets.size > 0 && ctx.dataRepo) {
    const plans: FragmentOutputPlan[] = [];
    for (const target of [...fragmentTargets].sort()) {
      try {
        plans.push(
          await planFragmentOutput({
            memo: ctx.memo,
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
          ctx.memo,
        ),
      );
      const refs = [...(fragmentItems.get(target) ?? [])].sort();
      if (refs.length > 0) {
        reviewCommands.set(
          target,
          `capshelf status ${refs.join(" ")} --diff-view installed`,
        );
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
  return `capshelf status ${kind}/${name}${scope === "local" ? " --local" : ""} --diff-view installed`;
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
  entry: LockEntryV4;
  targets: FragmentTarget[];
  lockChanged: boolean;
}

interface TargetOutcome {
  result: UpdateResult;
  /** Lock entry to write into the target's scope when this is not a dry run. */
  newEntry?: LockEntryV4;
  /** Whether the pinned content changed (marks the scope's lock dirty). */
  changed?: boolean;
  /** Fragment items defer their lock write and reconcile after the loop. */
  fragment?: FragmentContribution;
}

async function updateOneTarget(
  ctx: UpdateContext,
  target: ScopedTarget,
  entry: LockEntryV4,
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
  entry: DataLockEntryV4,
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
        sha: entryIdentity(entry),
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

  // One pin from the committed tree, exactly as `add` builds it. Under lock
  // version 4 there is no second identity to keep in step: the working tree is
  // not consulted, so a checkout filter or an index bit cannot move the value
  // this records.
  const pin = await pinCurrentSource(ctx.dataRepo, parsed.kind, parsed.name, {
    memo: ctx.memo,
  });
  const sha = pin.sourcePinDigest;
  const sourceCommit = pin.sourceCommit;
  if (isCopyDirectoryItemKind(parsed.kind)) {
    await assertNoDestinationCollisions(
      `${parsed.kind}/${parsed.name}`,
      installedPath(ctx.project, parsed.kind, parsed.name),
      pin.entries.map((treeEntry) => treeEntry.path),
    );
  }
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
    sha !== entry.sourcePinDigest || sourceCommit !== entry.sourceCommit;
  const lockWouldChange =
    contentWouldChange || needsWouldChange || entry.needsSourceCommit === null;
  const newEntry = refreshDataLockEntry(entry, {
    pin,
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
    // PIN-8 stops here for fragments. A fragment's installed state is merged
    // into a shared output alongside other fragments and the project's own
    // values, so with the previous pin unreadable capshelf cannot tell this
    // item's former contribution from a project-local value: removing it may
    // discard the user's configuration and keeping it may leave dead managed
    // state. The consent prompt cannot describe that choice, so the item is
    // refused with the one path that is unambiguous.
    const targets = await touchedFragmentTargetsForItem(
      ctx.dataRepo,
      parsed.kind,
      parsed.name,
      entry,
      ctx.manifest,
      ctx.memo,
    ).catch(async (cause: unknown) => {
      if (await commitExists(ctx.dataRepo!, entry.sourceCommit)) {
        throw new PreconditionError(
          `${cause instanceof Error ? cause.message : String(cause)}\n  repair the source or restore its Git objects, then retry`,
          { cause },
        );
      }
      throw new PreconditionError(
        `not updating ${parsed.kind}/${parsed.name} — its locked source commit ${entry.sourceCommit} cannot be resolved, and a fragment's contribution cannot be recovered from the merged output\n` +
          `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
          "  remove and re-add the item instead:\n" +
          `    ${PRODUCT_NAME} rm ${parsed.kind}/${parsed.name}\n` +
          `    ${PRODUCT_NAME} add ${parsed.kind}/${parsed.name}`,
      );
    });
    return {
      result: {
        key,
        scope,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: changedAction ?? "already-current",
        sha,
        lockedSha: entryIdentity(entry),
        plannedSha: sha,
        sourceCommit,
        ...(ctx.dryRun && { dryRun: true as const }),
      },
      fragment: { key, entry: newEntry, targets, lockChanged: lockWouldChange },
    };
  }

  const installedSha = needsWouldChange
    ? parsed.kind === "subagents"
      ? await installedSubagentShaAtPin(
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
          const before = await installedSubagentShaAtPin(
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
          source: contentSourceFor({
            entry: newEntry,
            kind: parsed.kind,
            name: parsed.name,
            repo: ctx.dataRepo,
          }),
          manifest: ctx.manifest,
          kind: parsed.kind,
          name: parsed.name,
          key,
          entry: newEntry,
          previous: {
            entry,
            source: contentSourceFor({
              entry,
              kind: parsed.kind,
              name: parsed.name,
              repo: ctx.dataRepo,
            }),
          },
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
      lockedSha: entryIdentity(entry),
      plannedSha: sha,
      sourceCommit,
      runtimeWarnings,
      ...(ctx.dryRun && { dryRun: true as const }),
    },
    newEntry,
    changed: lockWouldChange,
  };
}

/**
 * The installed subagent sha as the *previous* pin describes it. PIN-8: an
 * unresolvable previous commit makes the installed state unclassifiable, which
 * is a missing "current" value in the report, not a reason to refuse the
 * update whose target is the new commit.
 */
async function installedSubagentShaAtPin(
  project: string,
  dataRepo: string,
  name: string,
  commit: string,
): Promise<string | null> {
  return await shaOfInstalledSubagent(project, dataRepo, name, commit).catch(
    () => null,
  );
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
    source: contentSourceFor({
      entry: newEntry,
      kind: parsed.kind,
      name: parsed.name,
    }),
    kind: parsed.kind,
    name: parsed.name,
    key,
    manifest: ctx.manifest,
    entry: newEntry,
    previous: {
      entry,
      source: contentSourceFor({
        entry,
        kind: parsed.kind,
        name: parsed.name,
      }),
    },
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
      lockedSha: entryIdentity(entry),
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
    } else if (r.action === "merged" || r.action === "would-merge") {
      console.log(
        `${r.action === "merged" ? "✓" : "•"} ${id} ${
          r.action === "merged"
            ? "merged upstream into installed copy"
            : "would merge upstream into installed copy"
        }`,
      );
      console.log(`  base: ${r.mergeBase}`);
      console.log(`  upstream pin: ${r.mergedUpstreamCommit}`);
      console.log(`  installed result: ${r.mergeResultSha}`);
      const scopeFlag = r.scope === "local" ? " --local" : "";
      console.log(
        `  review: ${PRODUCT_NAME} status ${r.kind}/${r.name}${scopeFlag} --diff-view installed`,
      );
      console.log(
        `  publish: ${PRODUCT_NAME} promote ${r.kind}/${r.name}${scopeFlag} -m "..."`,
      );
      printRuntimeWarnings(r.runtimeWarnings);
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
    console.log(`  current: ${shortIdentity(r.currentSha)}`);
  }
  if (r.lockedSha) console.log(`  locked: ${shortIdentity(r.lockedSha)}`);
  if (r.plannedSha) console.log(`  planned: ${shortIdentity(r.plannedSha)}`);
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
