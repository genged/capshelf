import type { Command } from "commander";
import { existsSync } from "node:fs";
import {
  assertDestructivePlanUnchanged,
  confirmDestructiveChanges,
  createDestructiveChangePlan,
} from "../destructive-change";
import {
  planCopyDirectoryRemoval,
  planFragmentDestruction,
  planSubagentDestruction,
} from "../destructive-preflight";
import { rmTreeWithRetries } from "../fs-utils";
import { projectRoot } from "../paths";
import { resolveProjectDataRepo } from "../command-context";
import { loadManifest, saveManifest } from "../manifest";
import { manifestNamesForKind, removeManifestName } from "../manifest";
import {
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
  dataKey,
} from "../lock";
import type { ItemKind } from "../master";
import { CliError, NotFoundError, PreconditionError } from "../errors";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  ITEM_KINDS,
} from "../master";
import { PRODUCT_NAME } from "../identity";
import {
  installedPath,
  parseLockKey,
  removeInstallAliases,
} from "../installed";
import { isSystemItemName } from "../bundled";
import { lockKeysForRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  assertLocalScopeSupported,
  loadLocalConfig,
  localConfigNamesForKind,
  removeLocalConfigName,
  removeLocalExcludes,
  saveLocalConfig,
} from "../local-config";
import {
  applyFragmentOutputPlans,
  fragmentContributionState,
  fragmentOutputPath,
  lockedFragmentTargetsForItem,
  planFragmentOutput,
  type FragmentOutputPlan,
  type FragmentTarget,
} from "../fragments";
import { removeSubagentOutputs } from "../subagents";

interface RmOptions {
  json?: boolean;
  local?: boolean;
  yes?: boolean;
}

export function registerRm(program: Command): void {
  program
    .command("rm <item>")
    .description("remove a locked data item from the current project")
    .option("--local", "remove a local-scope item")
    .option("--yes", "authorize deletion of detected local changes")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: RmOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (opts.local && ref.kind) {
        assertLocalScopeSupported(ref.kind, ref.name, "rm --local");
      }
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(
          `"${ref.name}" is a system item — managed by the CLI, cannot be removed. It will be re-installed by 'capshelf init' anyway.`,
        );
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = opts.local
        ? await loadLocalLock(project)
        : await loadLock(project);
      const localConfig = opts.local ? await loadLocalConfig(project) : null;
      const oldManifest = structuredClone(manifest);
      const oldLock = structuredClone(lock);

      const dataKeys = lockKeysForRef(lock, ref).filter((key) => {
        const parsed = parseLockKey(key);
        return parsed.source === "data";
      });

      if (ref.kind === undefined || ref.kind === "skills") {
        const external = await findSkillsShSkill(project, ref.name);
        const hasLockedSkill = dataKeys.some(
          (key) => parseLockKey(key).kind === "skills",
        );
        if (
          external &&
          (ref.kind === "skills" || hasLockedSkill || dataKeys.length === 0)
        ) {
          throw new PreconditionError(
            `not removing skills/${ref.name} — ${skillsShConflictMessage(external)}`,
          );
        }
      }

      if (dataKeys.length > 1) {
        throw new PreconditionError(
          `ambiguous item "${ref.name}": found ${dataKeys
            .map((key) => {
              const parsed = parseLockKey(key);
              return `${parsed.kind}/${parsed.name}`;
            })
            .join(", ")}; use kind/name`,
        );
      }

      if (dataKeys.length === 0) {
        const trackedKinds = ITEM_KINDS.filter((k) => {
          if (ref.kind && k !== ref.kind) return false;
          if (opts.local) {
            return (
              localConfig !== null &&
              isCopyDirectoryItemKind(k) &&
              localConfigNamesForKind(localConfig, k).includes(ref.name)
            );
          }
          return manifestNamesForKind(manifest, k).includes(ref.name);
        });
        if (trackedKinds.length > 0) {
          const label = ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
          throw new PreconditionError(
            `not removing ${label} — no data lock entry exists, so installed files are not managed by capshelf\n` +
              "  remove local-only files manually, or repair the lock before running capshelf rm",
          );
        }
        // The item may be installed at the other scope; a bare "not installed"
        // would be a lie the user has no way to see through.
        const otherLock = opts.local
          ? await loadLock(project)
          : await loadLocalLock(project);
        const otherKeys = lockKeysForRef(otherLock, ref).filter(
          (key) => parseLockKey(key).source === "data",
        );
        if (otherKeys.length > 0) {
          const labels = otherKeys.map((key) => {
            const parsed = parseLockKey(key);
            return `${parsed.kind}/${parsed.name}`;
          });
          const scope = opts.local ? "project" : "local";
          const flag = opts.local ? "" : " --local";
          throw new PreconditionError(
            `${labels.join(", ")} is installed at ${scope} scope`,
            { hint: `remove it with: ${PRODUCT_NAME} rm${flag} ${labels[0]}` },
          );
        }
        throw new NotFoundError(`not installed in this project: ${itemRef}`);
      }

      const parsed = parseLockKey(dataKeys[0]!);
      const kind = parsed.kind as ItemKind;
      const name = parsed.name;
      const entry = oldLock.items[dataKey(kind, name)];
      if (entry?.source !== "data") {
        throw new Error(`expected data lock entry for data/${kind}/${name}`);
      }
      const dataRepo = await resolveProjectDataRepo(project, oldManifest, cmd);
      const nextManifest = structuredClone(manifest);
      const nextLock = structuredClone(lock);
      const nextLocalConfig = localConfig ? structuredClone(localConfig) : null;
      if (opts.local) {
        assertLocalScopeSupported(kind, name, "rm --local");
        if (!nextLocalConfig) throw new Error("no local manifest exists");
        removeLocalConfigName(nextLocalConfig, kind, name);
      } else {
        removeManifestName(nextManifest, kind, name);
      }
      delete nextLock.items[dataKey(kind, name)];

      const scope = opts.local ? "local" : "project";
      const reviewCommand = `${PRODUCT_NAME} status ${kind}/${name}${
        opts.local ? " --local" : ""
      } --diff`;
      const planRemoval = async (): Promise<{
        destructivePlan: ReturnType<typeof createDestructiveChangePlan>;
        fragmentPlans: FragmentOutputPlan[];
      }> => {
        const changes = [];
        const snapshotParts = [
          `entry:${JSON.stringify(entry)}`,
          `next-lock:${JSON.stringify(nextLock)}`,
        ];
        const fragmentPlans: FragmentOutputPlan[] = [];
        if (isFragmentItemKind(kind)) {
          const targets = await lockedFragmentTargetsForItem(
            dataRepo,
            kind,
            name,
            entry,
            oldManifest,
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
                manifest: nextManifest,
                oldManifest,
                nextManifest,
                oldLock,
                nextLock,
                target,
              }),
            );
            contributionStates.set(
              target,
              await fragmentContributionState(
                project,
                dataRepo,
                oldManifest,
                oldLock,
                target,
              ),
            );
            reviewCommands.set(target, reviewCommand);
          }
          const planned = planFragmentDestruction({
            project,
            plans: fragmentPlans,
            contributionStates,
            reviewCommands,
          });
          changes.push(...planned.changes);
          snapshotParts.push(...planned.snapshotParts);
        } else if (isCopyDirectoryItemKind(kind)) {
          const planned = await planCopyDirectoryRemoval({
            project,
            dataRepo,
            manifest: oldManifest,
            kind,
            name,
            key: dataKey(kind, name),
            scope,
            currentEntry: entry,
            reviewCommand,
          });
          changes.push(...planned.changes);
          snapshotParts.push(...planned.snapshotParts);
        } else if (isCopyTargetFileItemKind(kind)) {
          const planned = await planSubagentDestruction({
            project,
            dataRepo,
            name,
            key: dataKey(kind, name),
            scope,
            currentEntry: entry,
            selectedEntry: entry,
            reviewCommand,
          });
          changes.push(...planned.changes);
          snapshotParts.push(...planned.snapshotParts);
        }
        return {
          destructivePlan: createDestructiveChangePlan(changes, snapshotParts),
          fragmentPlans,
        };
      };

      const accepted = await planRemoval();
      if (
        !(await confirmDestructiveChanges(accepted.destructivePlan, {
          operation: `${PRODUCT_NAME} rm`,
          json: opts.json === true,
          yes: opts.yes === true,
          dryRun: false,
          rerunCommand: `${PRODUCT_NAME} rm ${kind}/${name}${
            opts.local ? " --local" : ""
          } --yes`,
        }))
      ) {
        return;
      }
      const revalidated = await planRemoval();
      assertDestructivePlanUnchanged(
        accepted.destructivePlan,
        revalidated.destructivePlan,
      );

      let path = "";
      let removed = false;
      if (isFragmentItemKind(kind)) {
        const targets = await lockedFragmentTargetsForItem(
          dataRepo,
          kind,
          name,
          entry,
          oldManifest,
        );
        path = targets[0] ? fragmentOutputPath(project, targets[0]) : "";
        for (const result of await applyFragmentOutputPlans(
          revalidated.fragmentPlans,
        )) {
          removed = removed || result.action === "reconciled";
        }
      } else if (isCopyDirectoryItemKind(kind)) {
        path = installedPath(project, kind, name, oldManifest.installMode);
        removed = await removeInstallAliases(
          project,
          kind,
          name,
          path,
          oldManifest.installMode,
        );
        if (existsSync(path)) {
          try {
            await rmTreeWithRetries(path);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new CliError(`could not delete ${path} (${detail})`, {
              hint:
                "another process may be writing to that directory (an agent runtime watching it?) — stop it and retry,\n" +
                "  or delete the directory manually and re-run this command to finish untracking",
              cause: err,
            });
          }
          removed = true;
        }
      } else if (isCopyTargetFileItemKind(kind)) {
        const paths = await removeSubagentOutputs(
          project,
          dataRepo,
          name,
          entry,
        );
        path = paths.join(", ");
        removed = paths.length > 0;
      } else {
        throw new Error(`no removal strategy for ${kind}/${name}`);
      }

      if (opts.local) {
        if (!nextLocalConfig) throw new Error("expected local manifest");
        await removeLocalExcludes(project, kind, name);
        await saveLocalConfig(project, nextLocalConfig);
        await saveLocalLock(project, nextLock);
      } else {
        await saveManifest(project, nextManifest);
        await saveLock(project, nextLock);
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: "data",
              scope: opts.local ? "local" : "project",
              kind,
              name,
              path,
              removedFiles: removed,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(
        `✓ removed ${opts.local ? "local/" : ""}data/${kind}/${name}`,
      );
      if (removed) {
        console.log(
          `  ${isFragmentItemKind(kind) ? "updated" : "deleted"} ${path}`,
        );
      }
    });
}
