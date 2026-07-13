import type { Command } from "commander";
import { loadProjectContext, resolveProjectDataRepo } from "../command-context";
import { parseLockKey } from "../installed";
import { assertNoScopeCollisions } from "../status-core";
import { PreconditionError, ResultExitError } from "../errors";
import { parseItemRef } from "../item-ref";
import { resolveTrackedTarget } from "../targets";
import type { ScopedTarget } from "../targets";
import { materializeLockEntry } from "../materialize";
import type { MaterializeResult } from "../materialize";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "../external";
import { printRuntimeWarnings } from "../runtime-warnings";
import { assertLocalScopeSupported } from "../local-config";
import {
  applyFragmentOutput,
  fragmentKindForTarget,
  lockedFragmentTargetsForItem,
  isFragmentKind,
  type FragmentApplyResult,
  type FragmentTarget,
} from "../fragments";

interface ApplyOptions {
  json?: boolean;
  dryRun?: boolean;
  local?: boolean;
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

export function registerApply(program: Command): void {
  program
    .command("apply [item]")
    .description(
      "converge installed files to match the manifest and lock; idempotent and safe to re-run",
    )
    .option("--dry-run", "preview planned changes without writing files")
    .option("--local", "apply only local project items")
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

        let targets: ScopedTarget[];
        if (itemRef) {
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

        const externalSkills = await listSkillsShSkills(project);
        const externalSkillNames = new Set(externalSkills.map((s) => s.name));
        const results: Array<
          MaterializeResult | ApplyError | ApplyExternalSkip
        > = [];
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
          try {
            results.push(
              addScope(
                scope,
                await materializeLockEntry({
                  project,
                  dataRepo,
                  manifest,
                  key,
                  entry: lock.items[key]!,
                  dryRun: opts.dryRun,
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

        for (const target of fragmentTargets) {
          try {
            if (!dataRepo) throw new Error("data repo is required");
            results.push(
              addScope(
                "project",
                fragmentApplyResult(
                  await applyFragmentOutput({
                    project,
                    dataRepo,
                    manifest,
                    oldLock: projectLock,
                    nextLock: projectLock,
                    target,
                    dryRun: opts.dryRun,
                  }),
                ),
              ),
            );
          } catch (err) {
            const kind = fragmentKindForTarget(target);
            results.push({
              scope: "project",
              key: `data/${target}/(merged)`,
              source: "data",
              kind,
              name: "(merged)",
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

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
          printApplyResults(results);
        }

        if (results.some((r) => r.action === "error")) {
          throw new ResultExitError(1);
        }
      },
    );
}

function printApplyResults(
  results: Array<MaterializeResult | ApplyError | ApplyExternalSkip>,
): void {
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
      if (r.message) console.log(`  ${r.message}`);
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
