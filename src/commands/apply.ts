import type { Command } from "commander";
import { GitReadMemo } from "../git-read-memo";
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
import { parseLockKey } from "../installed";
import { contentSourceFor } from "../item-source";
import type { GitTreeSource } from "../item-source";
import { PRODUCT_NAME } from "../identity";
import { dataKey, entryIdentity } from "../lock";
import type { Lock } from "../lock";
import type { Manifest } from "../manifest";
import { assertNoScopeCollisions } from "../status-core";
import { PreconditionError, ResultExitError } from "../errors";
import { parseItemRef } from "../item-ref";
import { resolveTrackedTarget } from "../targets";
import type { ScopedTarget } from "../targets";
import { materializeLockEntry } from "../materialize";
import { remoteCacheState } from "../remote-cache";
import { remoteTreeSource } from "../remote-discovery";
import {
  coldCacheRefusal,
  reconcileRemoteSkill,
  remoteEntryAsDataEntry,
} from "../remote-item";
import {
  REMOTE_ITEM_KIND,
  loadRemotesLock,
  parseRemoteKey,
  remoteKeysForRef,
} from "../remotes-lock";
import type { RemoteLockEntry, RemotesLock } from "../remotes-lock";
import type { MaterializeResult } from "../materialize";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "../external";
import { printRuntimeWarnings } from "../runtime-warnings";
import { assertLocalScopeSupported } from "../local-config";
import {
  isCopyDirectoryItemKind,
  isFragmentKindName,
  isMaterializedItemKind,
} from "../master";
import { materializeSubagent, shaOfInstalledSubagent } from "../subagents";
import {
  applyFragmentOutputPlans,
  fragmentContributionState,
  fragmentKindForTarget,
  fragmentTargetKey,
  lockedFragmentTargetsForItem,
  isFragmentKind,
  planFragmentOutput,
  type FragmentOutputPlan,
  type FragmentApplyResult,
  type FragmentTarget,
} from "../fragments";

interface ApplyOptions {
  json?: boolean;
  dryRun?: boolean;
  local?: boolean;
  yes?: boolean;
}

interface ApplyError {
  scope: "project" | "local";
  key: string;
  source: string;
  kind: string;
  name: string;
  action: "error";
  error: string;
}

interface ApplyExternalSkip {
  scope: "project" | "local";
  key: string;
  source: string;
  kind: string;
  name: string;
  action: "skipped-external";
  message: string;
}

/**
 * A pulled skill's row. `MaterializeResult.source` is an `ItemSource`, which a
 * remote row is not, so the reporting row is its own variant rather than a
 * widening of the writer's result type.
 */
interface ApplyRemoteResult {
  scope: "local";
  key: string;
  source: "remote";
  kind: typeof REMOTE_ITEM_KIND;
  name: string;
  action: MaterializeResult["action"];
  path: string;
  sha: string | null;
  currentSha?: string | null;
  plannedSha?: string | null;
}

type ApplyResult =
  | MaterializeResult
  | ApplyError
  | ApplyExternalSkip
  | ApplyRemoteResult;

interface ApplyPreflightInput {
  memo: GitReadMemo;
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  dataRepo: string | undefined;
  targets: ScopedTarget[];
  /** Pulled skills, resolved outside the capshelf locks by A3. */
  remoteTargets: RemoteApplyTarget[];
  remotes: RemotesLock;
  externalSkillNames: Set<string>;
  explicit: boolean;
}

interface RemoteApplyTarget {
  name: string;
  key: string;
}

interface ApplyPreflight {
  results: ApplyResult[];
  destructivePlan: DestructiveChangePlan;
}

export function registerApply(program: Command): void {
  program
    .command("apply [item]")
    .description(
      "converge installed files to match the manifest and lock after reviewing local changes",
    )
    .option("--dry-run", "preview planned changes without writing files")
    .option("--local", "apply only local project items")
    .option("--yes", "authorize destructive changes found by preflight")
    .option("--json", "output JSON")
    .action(
      async (itemRef: string | undefined, opts: ApplyOptions, cmd: Command) => {
        if (itemRef && opts.local) {
          const ref = parseItemRef(itemRef);
          if (ref.kind) {
            assertLocalScopeSupported(ref.kind, ref.name, "apply --local");
          }
        }
        const { project, manifest, projectLock, localLock } =
          await loadProjectContext({ cmd });
        assertNoScopeCollisions(projectLock, localLock, "applying");
        const remotes = await loadRemotesLock(project);
        // A remote row is resolved before the shared resolver runs: passing a
        // ref it cannot see would throw `not tracked in this project`. Every
        // remote row is local scope by D5, and `apply` has no project-only
        // flag, so a bare run and `--local` both include them.
        const remoteTargets: RemoteApplyTarget[] = (
          itemRef === undefined
            ? Object.keys(remotes.items)
            : remoteKeysForRef(remotes, parseItemRef(itemRef))
        ).map((key) => ({ key, name: parseRemoteKey(key).name }));

        let targets: ScopedTarget[];
        if (itemRef && remoteTargets.length > 0) {
          targets = [];
        } else if (itemRef) {
          targets = [
            await resolveTrackedTarget(
              project,
              projectLock,
              localLock,
              itemRef,
              { local: opts.local, verb: "applying" },
            ),
          ];
        } else {
          targets = [
            ...(!opts.local
              ? Object.keys(projectLock.items).map((key) => ({
                  scope: "project" as const,
                  key,
                }))
              : []),
            ...Object.keys(localLock.items).map((key) => ({
              scope: "local" as const,
              key,
            })),
          ];
        }

        const needsDataRepo = targets.some(
          (target) => parseLockKey(target.key).source === "data",
        );
        const dataRepo = needsDataRepo
          ? await resolveProjectDataRepo(project, manifest, cmd)
          : undefined;

        const memo = new GitReadMemo();
        const externalSkills = await listSkillsShSkills(project);
        const externalSkillNames = new Set(externalSkills.map((s) => s.name));
        const preflight = await planApplyPreflight({
          memo,
          project,
          manifest,
          projectLock,
          localLock,
          dataRepo,
          targets,
          remoteTargets,
          remotes,
          externalSkillNames,
          explicit: itemRef !== undefined,
        });
        if (opts.dryRun) {
          printApplyOutput({
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
        // All-or-nothing only for fragment targets: they share output files
        // (.claude/settings.json, .mcp.json, .codex/config.toml), so a
        // partial write leaves the runtime diverged from the lock.
        // Independent copy items share nothing, so one stale pin must not
        // cost the project `apply` — including self-healing of the bundled
        // system items.
        const fragmentPreflightFailed = preflight.results.some(
          (result) =>
            result.action === "error" && isFragmentKindName(result.kind),
        );
        if (fragmentPreflightFailed) {
          printApplyOutput({
            project,
            dataRepo,
            dryRun: false,
            // Nothing ran, so reporting the preflight's `would reconcile`
            // previews as if they were outcomes would be a lie.
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
            operation: "Apply",
            json: opts.json === true,
            yes: opts.yes === true,
            dryRun: false,
            rerunCommand: applyRerunCommand(itemRef, opts.local === true),
          }))
        ) {
          return;
        }
        const revalidated = await planApplyPreflight({
          memo,
          project,
          manifest,
          projectLock,
          localLock,
          dataRepo,
          targets,
          remoteTargets,
          remotes,
          externalSkillNames,
          explicit: itemRef !== undefined,
        });
        assertDestructivePlanUnchanged(
          preflight.destructivePlan,
          revalidated.destructivePlan,
        );

        const results: ApplyResult[] = [];
        const fragmentTargets = new Set<FragmentTarget>();
        for (const target of targets) {
          const { scope, key } = target;
          const lock = scope === "local" ? localLock : projectLock;
          const parsed = parseLockKey(key);
          if (scope === "local") {
            assertLocalScopeSupported(
              parsed.kind,
              parsed.name,
              "apply --local",
            );
          }
          if (parsed.kind === "skills" && externalSkillNames.has(parsed.name)) {
            const external = await findSkillsShSkill(project, parsed.name);
            const message = external
              ? skillsShConflictMessage(external)
              : "managed by skills.sh";
            if (itemRef) {
              throw new PreconditionError(
                `not applying skills/${parsed.name} — ${message}`,
              );
            }
            results.push({
              scope,
              key,
              source: parsed.source,
              kind: parsed.kind,
              name: parsed.name,
              action: "skipped-external",
              message,
            });
            continue;
          }
          if (isFragmentKind(parsed.kind)) {
            try {
              if (!dataRepo) throw new Error("data repo is required");
              const entry = lock.items[key]!;
              if (entry.source !== "data") {
                throw new Error(`expected data lock entry for ${key}`);
              }
              for (const outputTarget of await lockedFragmentTargetsForItem(
                dataRepo,
                parsed.kind,
                parsed.name,
                entry,
                manifest,
                memo,
              )) {
                fragmentTargets.add(outputTarget);
              }
            } catch (err) {
              results.push({
                scope,
                key,
                source: parsed.source,
                kind: parsed.kind,
                name: parsed.name,
                action: "error",
                error: err instanceof Error ? err.message : String(err),
              });
            }
            continue;
          }
          if (!isMaterializedItemKind(parsed.kind)) {
            throw new Error(
              `no apply strategy for ${parsed.kind}/${parsed.name}`,
            );
          }
          try {
            if (parsed.kind === "subagents") {
              if (!dataRepo) throw new Error("data repo is required");
              const entry = lock.items[key]!;
              if (entry.source !== "data") {
                throw new Error(`expected data lock entry for ${key}`);
              }
              const applied = await materializeSubagent({
                project,
                dataRepo,
                name: parsed.name,
                entry,
              });
              for (const warning of applied.warnings) {
                console.error(`⚠ ${warning}`);
              }
              results.push(
                addScope(scope, {
                  key,
                  source: parsed.source,
                  kind: parsed.kind,
                  name: parsed.name,
                  action: applied.changed ? "reconciled" : "already-current",
                  path: applied.paths.join(", "),
                  sha: entryIdentity(entry),
                }),
              );
              continue;
            }
            const entry = lock.items[key]!;
            results.push(
              addScope(
                scope,
                await materializeLockEntry({
                  project,
                  source: contentSourceFor({
                    entry,
                    kind: parsed.kind,
                    name: parsed.name,
                    repo: dataRepo,
                  }),
                  manifest,
                  kind: parsed.kind,
                  name: parsed.name,
                  key,
                  entry,
                  scope,
                }),
              ),
            );
          } catch (err) {
            results.push({
              scope,
              key,
              source: parsed.source,
              kind: parsed.kind,
              name: parsed.name,
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // A remote row converges to the pin the user already accepted, so
        // `apply` never re-consents: A9 covers a pin *move*, and this is not
        // one. The destructive plan above still gated any local loss.
        for (const target of remoteTargets) {
          const entry = remotes.items[target.key]!;
          try {
            results.push(
              remoteApplyRow(
                target,
                entry,
                await reconcileRemoteSkill({
                  project,
                  name: target.name,
                  entry,
                }),
              ),
            );
          } catch (err) {
            results.push({
              scope: "local",
              key: target.key,
              source: "remote",
              kind: REMOTE_ITEM_KIND,
              name: target.name,
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const fragmentResults =
          fragmentTargets.size > 0
            ? await reconcileFragmentTargets({
                memo,
                project,
                dataRepo,
                manifest,
                projectLock,
                // Sorted, so the write order is the order preflight planned.
                targets: [...fragmentTargets].sort(),
              })
            : [];
        results.push(...fragmentResults);

        printApplyOutput({
          project,
          dataRepo,
          dryRun: false,
          results,
          destructivePlan: preflight.destructivePlan,
          json: opts.json === true,
        });
        if (
          !opts.json &&
          fragmentResults.some((result) => result.action === "error")
        ) {
          console.log(
            "  no fragment output changed; fragment outputs are reconciled together",
          );
        }

        if (results.some((r) => r.action === "error")) {
          throw new ResultExitError(1);
        }
      },
    );
}

/**
 * Write every fragment output as one transaction.
 *
 * Fragment outputs share files, so a write that fails after an earlier write
 * succeeded leaves one runtime disagreeing with the lock. One
 * `applyFragmentOutputPlans` call over all the plans rolls the earlier writes
 * back (docs/cli.md:449-457); a call per target cannot, because each call is
 * its own transaction.
 *
 * The failure is returned as a result row, not raised, so `apply --json` keeps
 * its `items` array and the command keeps exit 1 (docs/cli.md:253).
 */
async function reconcileFragmentTargets(input: {
  memo: GitReadMemo;
  project: string;
  dataRepo: string | undefined;
  manifest: Manifest;
  projectLock: Lock;
  targets: FragmentTarget[];
}): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const plans: FragmentOutputPlan[] = [];
  let planFailed = false;
  for (const target of input.targets) {
    try {
      if (!input.dataRepo) throw new Error("data repo is required");
      plans.push(
        await planFragmentOutput({
          memo: input.memo,
          project: input.project,
          dataRepo: input.dataRepo,
          manifest: input.manifest,
          oldLock: input.projectLock,
          nextLock: input.projectLock,
          target,
        }),
      );
    } catch (error) {
      planFailed = true;
      results.push(fragmentApplyError(target, error));
    }
  }
  // A target that cannot be planned stops the batch. The outputs are
  // reconciled together, so writing the rest would leave the set half applied.
  if (planFailed) return results;

  // The plan whose write is in flight, so the failure names the target that
  // produced it. The preflight read inside `applyFragmentOutputPlans` runs
  // before the first write, so it can fail with no plan in flight; report that
  // one under the first target, as `update` does.
  let attempted: FragmentTarget | undefined;
  try {
    const applied = await applyFragmentOutputPlans(plans, {
      beforeWrite: async (plan) => {
        attempted = plan.target;
      },
    });
    for (const result of applied) {
      results.push(addScope("project", fragmentApplyResult(result)));
    }
  } catch (error) {
    // Every attempted write was rolled back, so no target reports an outcome:
    // a `reconciled` row for a plan that was undone would be false.
    results.push(fragmentApplyError(attempted ?? plans[0]!.target, error));
  }
  return results;
}

async function planApplyPreflight(
  input: ApplyPreflightInput,
): Promise<ApplyPreflight> {
  const results: ApplyResult[] = [];
  const changes: DestructiveChange[] = [];
  const snapshotParts: string[] = [];
  const fragmentTargets = new Set<FragmentTarget>();
  const fragmentItems = new Map<FragmentTarget, Set<string>>();

  for (const { scope, key } of input.targets) {
    const lock = scope === "local" ? input.localLock : input.projectLock;
    const parsed = parseLockKey(key);
    const entry = lock.items[key]!;
    snapshotParts.push(`apply-entry:${scope}:${key}:${JSON.stringify(entry)}`);
    if (scope === "local") {
      assertLocalScopeSupported(parsed.kind, parsed.name, "apply --local");
    }
    if (parsed.kind === "skills" && input.externalSkillNames.has(parsed.name)) {
      const external = await findSkillsShSkill(input.project, parsed.name);
      const message = external
        ? skillsShConflictMessage(external)
        : "managed by skills.sh";
      if (input.explicit) {
        throw new PreconditionError(
          `not applying skills/${parsed.name} — ${message}`,
        );
      }
      results.push({
        scope,
        key,
        source: parsed.source,
        kind: parsed.kind,
        name: parsed.name,
        action: "skipped-external",
        message,
      });
      continue;
    }
    if (isFragmentKind(parsed.kind)) {
      try {
        if (!input.dataRepo) throw new Error("data repo is required");
        if (entry.source !== "data") {
          throw new Error(`expected data lock entry for ${key}`);
        }
        for (const target of await lockedFragmentTargetsForItem(
          input.dataRepo,
          parsed.kind,
          parsed.name,
          entry,
          input.manifest,
          input.memo,
        )) {
          fragmentTargets.add(target);
          const items = fragmentItems.get(target) ?? new Set<string>();
          items.add(`${parsed.kind}/${parsed.name}`);
          fragmentItems.set(target, items);
        }
      } catch (error) {
        results.push(applyError(scope, key, parsed, error));
      }
      continue;
    }
    if (!isMaterializedItemKind(parsed.kind)) {
      throw new Error(`no apply strategy for ${parsed.kind}/${parsed.name}`);
    }

    try {
      const reviewCommand = itemReviewCommand(parsed.kind, parsed.name, scope);
      if (parsed.kind === "subagents") {
        if (!input.dataRepo) throw new Error("data repo is required");
        if (entry.source !== "data") {
          throw new Error(`expected data lock entry for ${key}`);
        }
        const before = await shaOfInstalledSubagent(
          input.project,
          input.dataRepo,
          parsed.name,
          entry.sourceCommit,
        );
        const applied = await materializeSubagent({
          project: input.project,
          dataRepo: input.dataRepo,
          name: parsed.name,
          entry,
          dryRun: true,
        });
        results.push(
          addScope(scope, {
            key,
            source: parsed.source,
            kind: parsed.kind,
            name: parsed.name,
            action: applied.changed
              ? ("would-reconcile" as const)
              : ("already-current" as const),
            path: applied.paths.join(", "),
            sha: before,
            currentSha: before,
            // Deliberately not `entryIdentity(entry)`. `currentSha` is a
            // legacy content hash of the installed files, and every apply
            // result keeps the pair in one scheme so a consumer can compare
            // them; a v4 pin digest here would always look different, even for
            // `already-current`. Under v4 this is simply absent — a real gap,
            // recorded in local/TODO.md, whose fix is a hash of the desired
            // bytes (`shaOfSubagentAtCommit`), not the pin.
            plannedSha: entry.sha,
            dryRun: true,
          }),
        );
        const planned = await planSubagentDestruction({
          project: input.project,
          dataRepo: input.dataRepo,
          name: parsed.name,
          key,
          scope,
          currentEntry: entry,
          selectedEntry: entry,
          reviewCommand,
        });
        changes.push(...planned.changes);
        snapshotParts.push(...planned.snapshotParts);
        continue;
      }

      const source = contentSourceFor({
        entry,
        kind: parsed.kind,
        name: parsed.name,
        repo: input.dataRepo,
      });
      const materialized = addScope(
        scope,
        await materializeLockEntry({
          project: input.project,
          source,
          manifest: input.manifest,
          kind: parsed.kind,
          name: parsed.name,
          key,
          entry,
          scope,
          dryRun: true,
        }),
      );
      results.push(materialized);
      if (
        materialized.action !== "kept-local" &&
        isCopyDirectoryItemKind(parsed.kind)
      ) {
        const planned = await planCopyDirectoryDestruction({
          project: input.project,
          currentSource: source,
          selectedSource: source,
          manifest: input.manifest,
          kind: parsed.kind,
          name: parsed.name,
          key,
          scope,
          currentEntry: entry,
          selectedEntry: entry,
          reviewCommand,
        });
        changes.push(...planned.changes);
        snapshotParts.push(...planned.snapshotParts);
      }
    } catch (error) {
      results.push(applyError(scope, key, parsed, error));
    }
  }

  const fragmentPlans: FragmentOutputPlan[] = [];
  if (fragmentTargets.size > 0 && input.dataRepo) {
    for (const target of [...fragmentTargets].sort()) {
      try {
        fragmentPlans.push(
          await planFragmentOutput({
            memo: input.memo,
            project: input.project,
            dataRepo: input.dataRepo,
            manifest: input.manifest,
            oldLock: input.projectLock,
            nextLock: input.projectLock,
            target,
          }),
        );
      } catch (error) {
        results.push(fragmentApplyError(target, error));
      }
    }
    for (const result of await applyFragmentOutputPlans(fragmentPlans, {
      dryRun: true,
    })) {
      results.push(addScope("project", fragmentApplyResult(result)));
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
          input.project,
          input.dataRepo,
          input.manifest,
          input.projectLock,
          target,
          input.memo,
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
    const planned = planFragmentDestruction({
      project: input.project,
      plans: fragmentPlans,
      contributionStates,
      reviewCommands,
    });
    changes.push(...planned.changes);
    snapshotParts.push(...planned.snapshotParts);
  }

  // Pulled skills, after the shelf pass. Their bytes are in the clone cache,
  // so the planner takes a git-tree source at the recorded subpath: before the
  // caller supplied one it would have planned against `skills/<name>` in the
  // cache, which is a different tree or no tree at all.
  for (const target of input.remoteTargets) {
    const entry = input.remotes.items[target.key]!;
    try {
      const source = remoteApplySource(target.name, entry);
      results.push(
        remoteApplyRow(
          target,
          entry,
          await materializeLockEntry({
            project: input.project,
            source,
            manifest: input.manifest,
            kind: REMOTE_ITEM_KIND,
            name: target.name,
            key: dataKey(REMOTE_ITEM_KIND, target.name),
            entry: remoteEntryAsDataEntry(entry),
            scope: "local",
            dryRun: true,
          }),
        ),
      );
      const planned = await planCopyDirectoryDestruction({
        project: input.project,
        currentSource: source,
        selectedSource: source,
        manifest: input.manifest,
        kind: REMOTE_ITEM_KIND,
        name: target.name,
        key: target.key,
        scope: "local",
        currentEntry: remoteEntryAsDataEntry(entry),
        selectedEntry: remoteEntryAsDataEntry(entry),
        reviewCommand: `${PRODUCT_NAME} status ${REMOTE_ITEM_KIND}/${target.name} --diff-view installed`,
      });
      changes.push(...planned.changes);
      snapshotParts.push(...planned.snapshotParts);
    } catch (error) {
      // A named target's failure is the command's failure, the way a
      // skills.sh-owned name is. A sweep records it and converges the rest.
      if (input.explicit) throw error;
      results.push({
        scope: "local",
        key: target.key,
        source: "remote",
        kind: REMOTE_ITEM_KIND,
        name: target.name,
        action: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const result of results) {
    snapshotParts.push(`apply-result:${JSON.stringify(result)}`);
  }
  return {
    results,
    destructivePlan: createDestructiveChangePlan(changes, snapshotParts),
  };
}

/** The cache tree a remote row reads, or the refusal that names the fetch. */
function remoteApplySource(
  name: string,
  entry: RemoteLockEntry,
): GitTreeSource {
  const cache = remoteCacheState(entry.upstream);
  if (!cache.present) throw coldCacheRefusal(name, entry);
  return remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath);
}

function applyError(
  scope: "project" | "local",
  key: string,
  parsed: { source: string; kind: string; name: string },
  cause: unknown,
): ApplyError {
  return {
    scope,
    key,
    source: parsed.source,
    kind: parsed.kind,
    name: parsed.name,
    action: "error",
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

function fragmentApplyError(
  target: FragmentTarget,
  cause: unknown,
): ApplyError {
  return applyError(
    "project",
    fragmentTargetKey(target),
    {
      source: "data",
      kind: fragmentKindForTarget(target),
      name: "(merged)",
    },
    cause,
  );
}

function itemReviewCommand(
  kind: string,
  name: string,
  scope: "project" | "local",
): string {
  return `capshelf status ${kind}/${name}${scope === "local" ? " --local" : ""} --diff-view installed`;
}

function applyRerunCommand(
  itemRef: string | undefined,
  local: boolean,
): string {
  return `capshelf apply${itemRef ? ` ${itemRef}` : ""}${local ? " --local" : ""} --yes`;
}

function printApplyOutput(opts: {
  project: string;
  dataRepo: string | undefined;
  dryRun: boolean;
  results: ApplyResult[];
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
  printApplyResults(opts.results);
  // Once per run, not per item: the marker is now cleared by exactly one
  // command, so a project with several marked items should say so once.
  const keptLocal = opts.results.filter(
    (result) => result.action === "kept-local",
  );
  if (keptLocal.length > 0) {
    const first = keptLocal[0]!;
    const scope = "scope" in first ? first.scope : "project";
    console.log(
      `  clear a keep-local marker to have it reconciled again: ${PRODUCT_NAME} keep-local ${first.kind}/${first.name}${
        scope === "local" ? " --local" : ""
      } --unset`,
    );
  }
  if (opts.dryRun && opts.destructivePlan.changes.length > 0) {
    console.log(
      renderDestructiveChanges("Apply", opts.destructivePlan.changes),
    );
  }
}

function remoteApplyRow(
  target: RemoteApplyTarget,
  entry: RemoteLockEntry,
  result: MaterializeResult,
): ApplyRemoteResult {
  return {
    scope: "local",
    key: target.key,
    source: "remote",
    kind: REMOTE_ITEM_KIND,
    name: target.name,
    action: result.action,
    path: result.path,
    sha: entry.sourcePinDigest,
    ...(result.currentSha !== undefined && { currentSha: result.currentSha }),
    ...(result.plannedSha !== undefined && { plannedSha: result.plannedSha }),
  };
}

function printApplyResults(results: ApplyResult[]): void {
  if (results.length === 0) {
    console.log("(no items tracked)");
    return;
  }
  for (const r of results) {
    const scope = "scope" in r ? r.scope : "project";
    const id = `${scope}/${r.source}/${r.kind}/${r.name}`;
    if (r.action === "error") {
      console.log(`✗ ${id} error`);
      console.log(`  ${r.error}`);
    } else if (r.action === "skipped-external") {
      console.log(`• ${id} skipped`);
      console.log(`  ${r.message}`);
    } else if (r.action === "kept-local") {
      console.log(`• ${id} kept local`);
      // A remote row is never kept-local: the marker is a shelf-lock field and
      // a remote entry has none.
      if ("message" in r && r.message) console.log(`  ${r.message}`);
    } else if (r.action === "would-reconcile") {
      console.log(`• ${id} would reconcile`);
      console.log(`  ${r.path}`);
      console.log(`  current: ${r.currentSha ?? "(missing)"}`);
      console.log(`  planned: ${r.plannedSha}`);
    } else {
      console.log(`✓ ${id} ${r.action}`);
      console.log(`  ${r.path}`);
    }
    if ("runtimeWarnings" in r) printRuntimeWarnings(r.runtimeWarnings);
  }
}

function fragmentApplyResult(result: FragmentApplyResult): MaterializeResult {
  const kind = fragmentKindForTarget(result.target);
  return {
    key: result.key,
    source: "data",
    kind,
    name: "(merged)",
    action: result.action,
    path: result.path,
    sha: result.plannedSha,
    currentSha: result.currentSha,
    plannedSha: result.plannedSha,
    ...(result.dryRun && { dryRun: true as const }),
  };
}

function addScope<T extends MaterializeResult>(
  scope: "project" | "local",
  result: T,
): T & { scope: "project" | "local" } {
  return { ...result, scope };
}
