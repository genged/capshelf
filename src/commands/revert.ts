import type { Command } from "commander";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  createDestructiveChangePlan,
} from "../destructive-change";
import {
  planCopyDirectoryDestruction,
  planFragmentDestruction,
  planSubagentDestruction,
} from "../destructive-preflight";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadManifest } from "../manifest";
import {
  entryIdentity,
  assertLockV4,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { LockEntry } from "../lock";
import { parseLockKey } from "../installed";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../global-options";
import { NotFoundError, PreconditionError } from "../errors";
import { assertLocalScopeSupported } from "../local-config";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { materializeLockEntry } from "../materialize";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { printRuntimeWarnings } from "../runtime-warnings";
import { isCopyDirectoryItemKind, isMaterializedItemKind } from "../master";
import {
  applyFragmentOutputPlans,
  fragmentContributionState,
  isFragmentKind,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
  type FragmentApplyResult,
  type FragmentOutputPlan,
  type FragmentTarget,
} from "../fragments";
import { materializeSubagent } from "../subagents";
import { PRODUCT_NAME } from "../identity";

interface RevertOptions {
  json?: boolean;
  local?: boolean;
  yes?: boolean;
}

export function registerRevert(program: Command): void {
  program
    .command("revert <item>")
    .description("discard local edits by reapplying locked content")
    .option("--local", "revert a local-scope item")
    .option("--yes", "authorize overwriting detected local changes")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: RevertOptions, cmd: Command) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = opts.local
        ? await loadLocalLock(project)
        : await loadLock(project);
      const ref = parseItemRef(itemRef);
      if (opts.local && ref.kind) {
        assertLocalScopeSupported(ref.kind, ref.name, "revert --local");
      }
      const key = lockKeyForRef(lock, ref);
      if (!key) {
        if (ref.kind === undefined || ref.kind === "skills") {
          const external = await findSkillsShSkill(project, ref.name);
          if (external) {
            throw new PreconditionError(
              `not reverting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
            );
          }
        }
        throw new NotFoundError(`not tracked in this project: ${itemRef}`);
      }

      const parsed = parseLockKey(key);
      if (opts.local) {
        assertLocalScopeSupported(parsed.kind, parsed.name, "revert --local");
      }
      if (parsed.kind === "skills") {
        const external = await findSkillsShSkill(project, parsed.name);
        if (external) {
          throw new PreconditionError(
            `not reverting skills/${parsed.name} — ${skillsShConflictMessage(external)}`,
          );
        }
      }
      const dataRepo =
        parsed.source === "data"
          ? await resolveDataRepo({
              override: globalOpts(cmd).data,
              manifest,
              project,
            })
          : undefined;
      if (dataRepo) await assertIsGitRepo(dataRepo);

      // PIN-12: before the source is read, so an unmigrated project is told to
      // migrate rather than shown a pin mismatch it cannot repair here.
      assertLockV4(lock, `${PRODUCT_NAME} revert`);
      const entry = lock.items[key]!;
      const scope = opts.local ? "local" : "project";
      const reviewCommand = `${PRODUCT_NAME} status ${parsed.kind}/${parsed.name}${
        opts.local ? " --local" : ""
      } --diff-view installed`;
      const planRevert = async () => {
        const changes = [];
        const snapshotParts = [`entry:${JSON.stringify(entry)}`];
        const fragmentPlans: FragmentOutputPlan[] = [];
        let fragmentResults: FragmentApplyResult[] = [];
        let path = "";
        let changed = false;

        if (isFragmentKind(parsed.kind)) {
          if (opts.local) {
            throw new PreconditionError(
              `--local is not supported for ${parsed.kind} fragments`,
            );
          }
          if (!dataRepo || entry.source !== "data") {
            throw new Error("data repo is required");
          }
          const targets = await lockedFragmentTargetsForItem(
            dataRepo,
            parsed.kind,
            parsed.name,
            entry,
            manifest,
          );
          const contributionStates = new Map<
            FragmentTarget,
            Awaited<ReturnType<typeof fragmentContributionState>>
          >();
          const reviewCommands = new Map<FragmentTarget, string>();
          for (const target of targets) {
            fragmentPlans.push(
              await planFragmentOutput({
                project,
                dataRepo,
                manifest,
                oldLock: lock,
                nextLock: lock,
                target,
              }),
            );
            contributionStates.set(
              target,
              await fragmentContributionState(
                project,
                dataRepo,
                manifest,
                lock,
                target,
              ),
            );
            reviewCommands.set(target, reviewCommand);
          }
          fragmentResults = await applyFragmentOutputPlans(fragmentPlans, {
            dryRun: true,
          });
          changed = fragmentPlans.some((plan) => plan.changed);
          path = fragmentPlans.map((plan) => plan.path).join(", ");
          const planned = planFragmentDestruction({
            project,
            plans: fragmentPlans,
            contributionStates,
            reviewCommands,
          });
          changes.push(...planned.changes);
          snapshotParts.push(...planned.snapshotParts);
        } else if (parsed.kind === "subagents" && entry.source === "data") {
          if (!dataRepo) throw new Error("data repo is required");
          const preview = await materializeSubagent({
            project,
            dataRepo,
            name: parsed.name,
            entry,
            previousEntry: entry,
            dryRun: true,
          });
          changed = preview.changed;
          path = preview.paths.join(", ");
          snapshotParts.push(`preview:${JSON.stringify(preview)}`);
          const planned = await planSubagentDestruction({
            project,
            dataRepo,
            name: parsed.name,
            key,
            scope,
            currentEntry: entry,
            selectedEntry: entry,
            reviewCommand,
          });
          changes.push(...planned.changes);
          snapshotParts.push(...planned.snapshotParts);
        } else if (isCopyDirectoryItemKind(parsed.kind)) {
          const preview = await materializeLockEntry({
            project,
            dataRepo,
            manifest,
            key,
            entry,
            previousEntry: entry,
            scope,
            ignoreLocal: true,
            dryRun: true,
          });
          changed = preview.action !== "already-current";
          path = preview.path;
          snapshotParts.push(`preview:${JSON.stringify(preview)}`);
          const planned = await planCopyDirectoryDestruction({
            project,
            dataRepo,
            manifest,
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
        } else if (!isMaterializedItemKind(parsed.kind)) {
          throw new Error(
            `no revert strategy for ${parsed.kind}/${parsed.name}`,
          );
        }

        return {
          changed,
          path,
          fragmentPlans,
          fragmentResults,
          destructivePlan: createDestructiveChangePlan(changes, snapshotParts),
        };
      };

      const accepted = await planRevert();
      if (!accepted.changed) {
        if (opts.json) {
          if (isFragmentKind(parsed.kind)) {
            console.log(
              JSON.stringify(
                accepted.fragmentResults.map(
                  ({ dryRun: _, ...result }) => result,
                ),
                null,
                2,
              ),
            );
          } else {
            console.log(
              JSON.stringify(
                {
                  key,
                  source: parsed.source,
                  kind: parsed.kind,
                  name: parsed.name,
                  action: "already-current",
                  path: accepted.path,
                  sha: entryIdentity(entry),
                },
                null,
                2,
              ),
            );
          }
          return;
        }
        console.log(
          `= already current ${opts.local ? "local/" : ""}${parsed.source}/${parsed.kind}/${parsed.name}`,
        );
        if (accepted.path) console.log(`  ${accepted.path}`);
        printKeptLocalNotice(entry, parsed, opts.local === true, "current");
        return;
      }
      if (
        !(await confirmDestructiveChanges(accepted.destructivePlan, {
          operation: `${PRODUCT_NAME} revert`,
          json: opts.json === true,
          yes: opts.yes === true,
          dryRun: false,
          rerunCommand: `${PRODUCT_NAME} revert ${parsed.kind}/${parsed.name}${
            opts.local ? " --local" : ""
          } --yes`,
        }))
      ) {
        return;
      }
      const revalidated = await planRevert();
      assertDestructivePlanUnchanged(
        accepted.destructivePlan,
        revalidated.destructivePlan,
      );

      // The keep-local marker records intent, not a fact about current
      // content, so revert restores bytes and leaves it alone. Only
      // `keep-local --unset` clears it. See the field doc in lock.ts.
      const nextLock = assertLockV4(
        structuredClone(lock),
        `${PRODUCT_NAME} revert`,
      );
      const nextEntry = nextLock.items[key]!;

      if (isFragmentKind(parsed.kind)) {
        const results = await applyFragmentOutputPlans(
          revalidated.fragmentPlans,
        );
        await saveLock(project, nextLock);
        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        console.log(
          `✓ reverted ${parsed.source}/${parsed.kind}/${parsed.name}`,
        );
        for (const result of results) console.log(`  ${result.path}`);
        return;
      }
      if (!isMaterializedItemKind(parsed.kind)) {
        throw new Error(`no revert strategy for ${parsed.kind}/${parsed.name}`);
      }

      const result =
        parsed.kind === "subagents" && nextEntry.source === "data"
          ? await (async () => {
              if (!dataRepo) throw new Error("data repo is required");
              const applied = await materializeSubagent({
                project,
                dataRepo,
                name: parsed.name,
                entry: nextEntry,
                previousEntry: entry.source === "data" ? entry : undefined,
              });
              for (const warning of applied.warnings) {
                console.error(`⚠ ${warning}`);
              }
              return {
                key,
                source: parsed.source,
                kind: parsed.kind,
                name: parsed.name,
                action: applied.changed
                  ? ("reconciled" as const)
                  : ("already-current" as const),
                path: applied.paths.join(", "),
                sha: entryIdentity(nextEntry),
                runtimeWarnings: undefined,
              };
            })()
          : await materializeLockEntry({
              project,
              dataRepo,
              manifest,
              key,
              entry: nextEntry,
              previousEntry: entry,
              scope: opts.local ? "local" : "project",
              ignoreLocal: true,
            });

      if (opts.local) await saveLocalLock(project, nextLock);
      else await saveLock(project, nextLock);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `✓ reverted ${opts.local ? "local/" : ""}${parsed.source}/${parsed.kind}/${parsed.name}`,
      );
      console.log(`  ${result.path}`);
      printKeptLocalNotice(entry, parsed, opts.local === true, "reverted");
      printRuntimeWarnings(result.runtimeWarnings);
    });
}

/**
 * Reverting a kept-local item is a behavior change users must see: the marker
 * survives, so the item stays skipped by `apply` and `update` until it is
 * explicitly cleared, and nothing else in the output would say so.
 */
function printKeptLocalNotice(
  entry: LockEntry,
  parsed: { kind: string; name: string },
  local: boolean,
  outcome: "reverted" | "current",
): void {
  if (entry.source !== "data" || entry.local !== true) return;
  const reason = entry.localReason ? ` (${entry.localReason})` : "";
  console.log(
    outcome === "reverted"
      ? `  keep-local marker kept${reason}`
      : `  keep-local marker is set${reason}; revert restores content only`,
  );
  console.log(
    `  clear it with: ${PRODUCT_NAME} keep-local ${parsed.kind}/${parsed.name}${
      local ? " --local" : ""
    } --unset`,
  );
}
