import type { Command } from "commander";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest } from "../manifest";
import { loadLocalLock, loadLock, saveLocalLock, saveLock } from "../lock";
import { parseLockKey } from "../installed";
import { isFragmentItemKind, shaOfGitVisibleItem } from "../master";
import { assertIsGitRepo, assertRepoClean, lastTouchingCommit } from "../git";
import { findSystemItem, shaOfSystemItem, CLI_VERSION } from "../bundled";
import { globalOpts } from "../cli";
import { findMasterItemByRef, lockKeysForRef, parseItemRef } from "../item-ref";
import { materializeLockEntry } from "../materialize";
import {
  findSkillsShSkill,
  listSkillsShSkills,
  skillsShConflictMessage,
} from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import {
  applyFragmentOutput,
  fragmentKindForTarget,
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

        const targets: Array<{ scope: "project" | "local"; key: string }> = [];
        if (refs.length > 0) {
          for (const itemRef of refs) {
            const ref = parseItemRef(itemRef);
            const matches = opts.local
              ? lockKeysForRef(localLock, ref).map((key) => ({
                  scope: "local" as const,
                  key,
                }))
              : [
                  ...lockKeysForRef(projectLock, ref).map((key) => ({
                    scope: "project" as const,
                    key,
                  })),
                  ...lockKeysForRef(localLock, ref).map((key) => ({
                    scope: "local" as const,
                    key,
                  })),
                ];
            if (matches.length === 0) {
              if (ref.kind === undefined || ref.kind === "skills") {
                const external = await findSkillsShSkill(project, ref.name);
                if (external) {
                  console.error(
                    `✗ not updating skills/${ref.name} — ${skillsShConflictMessage(external)}`,
                  );
                  process.exit(3);
                }
              }
              console.error(`✗ not tracked in this project: ${itemRef}`);
              process.exit(2);
            }
            if (matches.length > 1) {
              throw new Error(
                `ambiguous item "${ref.name}": found in ${matches
                  .map((match) => `${match.scope}/${match.key}`)
                  .join(", ")}; use --local or remove one owner`,
              );
            }
            targets.push(matches[0]!);
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
        const originalLock = cloneLock(projectLock);
        const fragmentNextLock = cloneLock(projectLock);
        const pendingFragmentEntries = new Map<
          string,
          (typeof projectLock.items)[string]
        >();
        const touchedFragmentTargets = new Set<FragmentTarget>();
        let fragmentLockChanged = false;

        for (const target of targets) {
          const { scope, key } = target;
          const lock = scope === "local" ? localLock : projectLock;
          const parsed = parseLockKey(key);
          const entry = lock.items[key]!;
          try {
            if (
              parsed.kind === "skills" &&
              externalSkillByName.has(parsed.name)
            ) {
              const message = skillsShConflictMessage(
                externalSkillByName.get(parsed.name)!,
              );
              if (explicit) {
                console.error(
                  `✗ not updating skills/${parsed.name} — ${message}`,
                );
                process.exit(3);
              }
              results.push({
                key,
                source: parsed.source,
                kind: parsed.kind,
                name: parsed.name,
                action: "skipped-external",
                error: message,
              });
              continue;
            }
            if (entry.source === "data") {
              if (entry.local === true) {
                const runtimeWarnings = runtimeWarningsForItem(
                  project,
                  parsed.kind,
                  parsed.name,
                );
                results.push({
                  key,
                  scope,
                  source: parsed.source,
                  kind: parsed.kind,
                  name: parsed.name,
                  action: "kept-local",
                  sha: entry.sha,
                  sourceCommit: entry.sourceCommit,
                  ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
                });
                continue;
              }
              if (!dataRepo) throw new Error("data repo is required");
              const item = await findMasterItemByRef(dataRepo, {
                kind: parsed.kind,
                name: parsed.name,
              });
              if (!item)
                throw new Error(
                  `missing upstream item: ${parsed.kind}/${parsed.name}`,
                );

              const sha = isFragmentItemKind(parsed.kind)
                ? await shaOfFragmentItem(dataRepo, parsed.kind, parsed.name)
                : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
              const sourceCommit = isFragmentItemKind(parsed.kind)
                ? await lastTouchingFragmentCommit(
                    dataRepo,
                    parsed.kind,
                    parsed.name,
                  )
                : await lastTouchingCommit(dataRepo, item.repoRelPath);
              const newEntry = {
                ...entry,
                sha,
                sourceCommit,
                appliedAt:
                  sha !== entry.sha || sourceCommit !== entry.sourceCommit
                    ? new Date().toISOString()
                    : entry.appliedAt,
              };
              const lockWouldChange =
                sha !== entry.sha || sourceCommit !== entry.sourceCommit;
              if (isFragmentItemKind(parsed.kind)) {
                if (scope === "local") {
                  throw new Error(
                    `--local is not supported for ${parsed.kind} fragments`,
                  );
                }
                fragmentLockChanged = fragmentLockChanged || lockWouldChange;
                fragmentNextLock.items[key] = newEntry;
                pendingFragmentEntries.set(key, newEntry);
                for (const target of await touchedFragmentTargetsForItem(
                  dataRepo,
                  parsed.kind,
                  parsed.name,
                  entry,
                  manifest,
                )) {
                  touchedFragmentTargets.add(target);
                }
                results.push({
                  key,
                  scope,
                  source: parsed.source,
                  kind: parsed.kind,
                  name: parsed.name,
                  action: lockWouldChange
                    ? opts.dryRun
                      ? "would-update"
                      : "updated"
                    : "already-current",
                  sha,
                  lockedSha: entry.sha,
                  plannedSha: sha,
                  sourceCommit,
                  ...(opts.dryRun && { dryRun: true as const }),
                });
                continue;
              }
              const materialized = await materializeLockEntry({
                project,
                dataRepo,
                manifest,
                key,
                entry: newEntry,
                dryRun: opts.dryRun,
              });
              if (!opts.dryRun) {
                lock.items[key] = newEntry;
                if (scope === "local") {
                  localChanged =
                    localChanged ||
                    sha !== entry.sha ||
                    sourceCommit !== entry.sourceCommit;
                } else {
                  projectChanged =
                    projectChanged ||
                    sha !== entry.sha ||
                    sourceCommit !== entry.sourceCommit;
                }
              }
              results.push({
                key,
                scope,
                source: parsed.source,
                kind: parsed.kind,
                name: parsed.name,
                action: lockWouldChange
                  ? opts.dryRun
                    ? "would-update"
                    : "updated"
                  : materialized.action,
                sha,
                currentSha: materialized.currentSha,
                lockedSha: entry.sha,
                plannedSha: sha,
                sourceCommit,
                runtimeWarnings: materialized.runtimeWarnings,
                ...(opts.dryRun && { dryRun: true as const }),
              });
            } else {
              const item = findSystemItem(parsed.name);
              if (!item || item.kind !== parsed.kind) {
                throw new Error(
                  `system item no longer bundled: ${parsed.kind}/${parsed.name}`,
                );
              }
              const sha = await shaOfSystemItem(item);
              const newEntry = {
                source: "system" as const,
                sha,
                cliVersion: CLI_VERSION,
                appliedAt:
                  sha !== entry.sha ||
                  entry.source !== "system" ||
                  entry.cliVersion !== CLI_VERSION
                    ? new Date().toISOString()
                    : entry.appliedAt,
              };
              const materialized = await materializeLockEntry({
                project,
                key,
                manifest,
                entry: newEntry,
                dryRun: opts.dryRun,
              });
              if (!opts.dryRun) {
                lock.items[key] = newEntry;
                projectChanged =
                  projectChanged ||
                  sha !== entry.sha ||
                  entry.source !== "system" ||
                  entry.cliVersion !== CLI_VERSION;
              }
              const lockWouldChange =
                sha !== entry.sha ||
                entry.source !== "system" ||
                entry.cliVersion !== CLI_VERSION;
              results.push({
                key,
                scope,
                source: parsed.source,
                kind: parsed.kind,
                name: parsed.name,
                action: lockWouldChange
                  ? opts.dryRun
                    ? "would-update"
                    : "updated"
                  : materialized.action,
                sha,
                currentSha: materialized.currentSha,
                lockedSha: entry.sha,
                plannedSha: sha,
                cliVersion: CLI_VERSION,
                runtimeWarnings: materialized.runtimeWarnings,
                ...(opts.dryRun && { dryRun: true as const }),
              });
            }
          } catch (err) {
            results.push({
              key,
              scope,
              source: parsed.source,
              kind: parsed.kind,
              name: parsed.name,
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (touchedFragmentTargets.size > 0 && dataRepo) {
          try {
            for (const target of touchedFragmentTargets) {
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
            }
            if (!opts.dryRun) {
              for (const [key, entry] of pendingFragmentEntries) {
                projectLock.items[key] = entry;
              }
              projectChanged = projectChanged || fragmentLockChanged;
            }
          } catch (err) {
            results.push({
              key: "data/fragments/(merged)",
              source: "data",
              kind: "settings",
              name: "(merged)",
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
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
        if (results.some((r) => r.action === "error")) process.exit(1);
      },
    );
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

function cloneLock<T>(lock: T): T {
  return JSON.parse(JSON.stringify(lock)) as T;
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
