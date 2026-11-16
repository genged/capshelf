import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
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
import { contentSourceOrNull } from "../item-source";
import { isErrno } from "../fs-utils";
import { removeInstalledTree } from "../mount-points";
import { projectRoot } from "../paths";
import { resolveProjectDataRepo } from "../command-context";
import {
  loadManifest,
  saveManifest,
  manifestNamesForKind,
  removeManifestName,
} from "../manifest";
import {
  assertWritableLock,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
  dataKey,
} from "../lock";
import { CliError, NotFoundError, PreconditionError } from "../errors";
import {
  installsAtSkillTarget,
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
import { remoteCacheState } from "../remote-cache";
import { remoteTreeSource } from "../remote-discovery";
import {
  loadRemotesLock,
  parseRemoteKey,
  remoteKeysForNamedRef,
  saveRemotesLock,
} from "../remotes-lock";
import type { RemotesLock } from "../remotes-lock";
import { assertRefNotSplitAcrossPopulations } from "../targets";
import type { Manifest } from "../manifest";
import type { Lock } from "../lock";
import { skillTargetOwnerLabel, skillTargetOwners } from "../skill-target";
import type { SkillTargetOwner } from "../skill-target";

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
      // Gate before any deletion: otherwise `rm --yes` deletes installed files
      // and then fails to write the lock, leaving the project inconsistent.
      assertWritableLock(lock, `${PRODUCT_NAME} rm`);
      const localConfig = opts.local ? await loadLocalConfig(project) : null;
      const oldManifest = structuredClone(manifest);
      const oldLock = structuredClone(lock);

      const dataKeys = lockKeysForRef(lock, ref).filter((key) => {
        const parsed = parseLockKey(key);
        return parsed.source === "data";
      });

      // A plugin row beside a skills.sh row is removed with the folder kept,
      // since skills.sh never installs plugins; a skill keeps the refusal
      // because skills.sh owns it.
      const remotes = await loadRemotesLock(project);
      const remoteKeys = remoteKeysForNamedRef(remotes, ref);
      if (ref.kind === undefined || installsAtSkillTarget(ref.kind)) {
        const external = await findSkillsShSkill(project, ref.name);
        const hasLockedSkillTarget = dataKeys.some((key) =>
          installsAtSkillTarget(parseLockKey(key).kind),
        );
        const tracksPlugin =
          remoteKeys.some((key) => parseRemoteKey(key).kind === "plugins") ||
          dataKeys.some((key) => parseLockKey(key).kind === "plugins");
        if (
          external &&
          !tracksPlugin &&
          (ref.kind !== undefined ||
            hasLockedSkillTarget ||
            dataKeys.length === 0)
        ) {
          throw new PreconditionError(
            `not removing ${ref.kind ?? "skills"}/${ref.name} — ${skillsShConflictMessage(external)}`,
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

      // Remote rows are in neither lock, and removing only one side of a
      // two-owner state orphans the other, so check both locks, not just the
      // one `--local` selects.
      assertRefNotSplitAcrossPopulations(
        await loadLock(project),
        await loadLocalLock(project),
        ref,
        remoteKeys,
      );
      if (dataKeys.length === 0 && remoteKeys.length > 0) {
        await removeRemoteItem({
          project,
          manifest,
          key: remoteKeys[0]!,
          remotes,
          projectLock: await loadLock(project),
          localLock: await loadLocalLock(project),
          json: opts.json === true,
          yes: opts.yes === true,
        });
        return;
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
        // The item may be installed at the other scope, so say so rather than a
        // misleading "not installed".
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
      const kind = parsed.kind;
      const name = parsed.name;
      const entry = oldLock.items[dataKey(kind, name)];
      if (entry?.source !== "data") {
        throw new Error(`expected data lock entry for data/${kind}/${name}`);
      }

      // Computed before any plan or consent so another owner's folder is never
      // reported as this item's local edits or deleted.
      let keptBy: SkillTargetOwner | null = null;
      let excludesNeeded = false;
      if (isCopyDirectoryItemKind(kind) && installsAtSkillTarget(kind)) {
        const otherOwners = (
          await skillTargetOwners(project, name, {
            project: opts.local ? await loadLock(project) : lock,
            local: opts.local ? lock : await loadLocalLock(project),
            remotes,
          })
        ).filter(
          (owner) =>
            owner.owner !== "unmanaged" &&
            // Only the selected scope's entry is this item; the same key in the
            // other scope (interrupted `move`) still owns the folder.
            !(
              owner.owner === (opts.local ? "local" : "project") &&
              owner.key === dataKey(kind, name)
            ),
        );
        keptBy = otherOwners[0] ?? null;
        excludesNeeded = otherOwners.some(
          (owner) => owner.owner === "local" || owner.owner === "remote",
        );
      }

      // Resolved lazily: copy directories are deleted from the project alone,
      // and requiring the data repo would make `rm` fail when the clone is gone
      // or upstream rewritten.
      let cachedDataRepo: string | undefined;
      const requireDataRepo = async (): Promise<string> => {
        cachedDataRepo ??= await resolveProjectDataRepo(
          project,
          oldManifest,
          cmd,
        );
        return cachedDataRepo;
      };
      const optionalDataRepo = async (): Promise<string | undefined> => {
        try {
          return await requireDataRepo();
        } catch {
          return undefined;
        }
      };
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
      } --diff-view installed`;
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
          const dataRepo = await requireDataRepo();
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
          // Skip planning for a folder another owner keeps: it would report
          // that owner's content as this item's local edits and demand `--yes`
          // for drift this item didn't create.
          if (keptBy) {
            snapshotParts.push(`kept-by:${JSON.stringify(keptBy)}`);
          } else {
            const planned = await planCopyDirectoryRemoval({
              project,
              currentSource: contentSourceOrNull({
                entry,
                kind,
                name,
                repo: await optionalDataRepo(),
              }),
              manifest: oldManifest,
              kind,
              name,
              key: dataKey(kind, name),
              scope,
              reviewCommand,
            });
            changes.push(...planned.changes);
            snapshotParts.push(...planned.snapshotParts);
          }
        } else if (isCopyTargetFileItemKind(kind)) {
          const planned = await planSubagentDestruction({
            project,
            dataRepo: await requireDataRepo(),
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
      let keptMountPoints: string[] = [];
      if (isFragmentItemKind(kind)) {
        const targets = await lockedFragmentTargetsForItem(
          await requireDataRepo(),
          kind,
          name,
          entry,
          oldManifest,
        );
        path = targets
          .map((target) => fragmentOutputPath(project, target))
          .join(", ");
        for (const result of await applyFragmentOutputPlans(
          revalidated.fragmentPlans,
        )) {
          removed = removed || result.action === "reconciled";
        }
      } else if (isCopyDirectoryItemKind(kind)) {
        path = installedPath(project, kind, name, oldManifest.installMode);
        if (!keptBy) {
          // Delete the folder first so a failed delete leaves aliases and the
          // lock row intact and a rerun can finish.
          if (existsSync(path)) {
            keptMountPoints = await deleteInstalledFolder(project, path);
            removed = true;
          }
          removed =
            (await removeInstallAliases(
              project,
              kind,
              name,
              path,
              oldManifest.installMode,
            )) || removed;
        }
      } else if (isCopyTargetFileItemKind(kind)) {
        const paths = await removeSubagentOutputs(
          project,
          await requireDataRepo(),
          name,
          entry,
        );
        path = paths.join(", ");
        removed = paths.length > 0;
      } else {
        throw new Error(`no removal strategy for ${kind}/${name}`);
      }

      const writableNextLock = assertWritableLock(
        nextLock,
        `${PRODUCT_NAME} rm`,
      );
      if (opts.local) {
        if (!nextLocalConfig) throw new Error("expected local manifest");
        // The exclude lines name the shared folder, identical for skills and
        // plugins, so keep them while a local-scope entry or remote row still
        // needs them.
        if (!excludesNeeded) await removeLocalExcludes(project, kind, name);
        await saveLocalConfig(project, nextLocalConfig);
        await saveLocalLock(project, writableNextLock);
      } else {
        await saveManifest(project, nextManifest);
        await saveLock(project, writableNextLock);
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
              ...(keptBy && { keptBy: skillTargetOwnerLabel(keptBy) }),
              ...(keptMountPoints.length > 0 && {
                keptMountPoints: keptMountPoints.map((mount) =>
                  relative(project, join(path, mount)),
                ),
              }),
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
      if (keptBy) {
        console.log(
          `  kept ${relative(project, path)}: it is installed by ${skillTargetOwnerLabel(keptBy)}`,
        );
      } else if (removed) {
        console.log(
          `  ${isFragmentItemKind(kind) ? "updated" : "deleted"} ${path}`,
        );
      }
      printKeptMountPoints(project, path, keptMountPoints);
    });
}

/**
 * A cold cache must not block removal: the locked file set only labels managed
 * paths, so without it every path is treated as extra_local_path and deleted
 * only with consent.
 */
async function removeRemoteItem(input: {
  project: string;
  manifest: Manifest;
  key: string;
  remotes: RemotesLock;
  projectLock: Lock;
  localLock: Lock;
  json: boolean;
  yes: boolean;
}): Promise<void> {
  const { project, key, remotes } = input;
  const { kind, name } = parseRemoteKey(key);
  const entry = remotes.items[key]!;
  const cache = remoteCacheState(entry.upstream);
  const reviewCommand = `${PRODUCT_NAME} status ${kind}/${name} --diff-view installed`;
  const otherOwners = (
    await skillTargetOwners(project, name, {
      project: input.projectLock,
      local: input.localLock,
      remotes,
    })
  ).filter(
    (owner) =>
      owner.owner !== "unmanaged" &&
      !(owner.owner === "remote" && owner.key === key),
  );
  const keptBy = otherOwners[0] ?? null;
  const excludesNeeded = otherOwners.some(
    (owner) => owner.owner === "local" || owner.owner === "remote",
  );
  const planRemoval = async (): Promise<
    ReturnType<typeof createDestructiveChangePlan>
  > => {
    if (keptBy) {
      return createDestructiveChangePlan(
        [],
        [
          `kept-by:${JSON.stringify(keptBy)}`,
          `remote-entry:${JSON.stringify(entry)}`,
        ],
      );
    }
    const planned = await planCopyDirectoryRemoval({
      project,
      currentSource: cache.present
        ? remoteTreeSource(cache.path, entry.sourceCommit, entry.subpath)
        : null,
      manifest: input.manifest,
      kind,
      name,
      key,
      scope: "local",
      reviewCommand,
    });
    return createDestructiveChangePlan(planned.changes, [
      ...planned.snapshotParts,
      `remote-entry:${JSON.stringify(entry)}`,
    ]);
  };

  const accepted = await planRemoval();
  if (
    !(await confirmDestructiveChanges(accepted, {
      operation: `${PRODUCT_NAME} rm`,
      json: input.json,
      yes: input.yes,
      dryRun: false,
      rerunCommand: `${PRODUCT_NAME} rm ${kind}/${name} --yes`,
    }))
  ) {
    return;
  }
  assertDestructivePlanUnchanged(accepted, await planRemoval());

  const path = installedPath(project, kind, name, input.manifest.installMode);
  let removed = false;
  let keptMountPoints: string[] = [];
  if (!keptBy) {
    if (existsSync(path)) {
      keptMountPoints = await deleteInstalledFolder(project, path);
      removed = true;
    }
    removed =
      (await removeInstallAliases(
        project,
        kind,
        name,
        path,
        input.manifest.installMode,
      )) || removed;
  }
  if (!excludesNeeded) await removeLocalExcludes(project, kind, name);
  delete remotes.items[key];
  await saveRemotesLock(project, remotes);

  if (input.json) {
    console.log(
      JSON.stringify(
        {
          source: "remote",
          scope: "local",
          kind,
          name,
          upstream: entry.upstream,
          path,
          removedFiles: removed,
          ...(keptBy && { keptBy: skillTargetOwnerLabel(keptBy) }),
          ...(keptMountPoints.length > 0 && {
            keptMountPoints: keptMountPoints.map((mount) =>
              relative(project, join(path, mount)),
            ),
          }),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`✓ removed ${key}`);
  if (keptBy) {
    console.log(
      `  kept ${relative(project, path)}: it is installed by ${skillTargetOwnerLabel(keptBy)}`,
    );
  } else if (removed) {
    console.log(`  deleted ${path}`);
  }
  printKeptMountPoints(project, path, keptMountPoints);
}

async function deleteInstalledFolder(
  project: string,
  path: string,
): Promise<string[]> {
  try {
    return await removeInstalledTree(path, { root: project });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    // A denial that survives the delete comes from a folder owned by another
    // user (e.g. written as root by a container), the parent folder, or an open
    // file.
    const cause =
      isErrno(err, "EACCES") || isErrno(err, "EPERM")
        ? "this user cannot write that directory, its parent, or a folder in it, or another process is using it. Fix the permissions or stop the process, then retry."
        : "another process may be writing to that directory (an agent runtime watching it?). Stop it and retry.";
    throw new CliError(`could not delete ${path} (${detail})`, {
      hint: `${cause}\n  The lock row and the aliases are unchanged, so a rerun of this command finishes the removal.`,
      cause: err,
    });
  }
}

function printKeptMountPoints(
  project: string,
  path: string,
  mounts: readonly string[],
): void {
  for (const mount of mounts) {
    console.log(
      `! kept ${relative(project, join(path, mount))}: it is a mounted volume`,
    );
  }
}
