import type { Command } from "commander";
import { existsSync } from "node:fs";
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
  applyFragmentOutput,
  fragmentOutputPath,
  lockedFragmentTargetsForItem,
} from "../fragments";

interface RmOptions {
  json?: boolean;
  local?: boolean;
}

export function registerRm(program: Command): void {
  program
    .command("rm <item>")
    .description("remove a locked data item from the current project")
    .option("--local", "remove a local-scope item")
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
      if (opts.local) {
        assertLocalScopeSupported(kind, name, "rm --local");
        if (!localConfig) throw new Error("no local manifest exists");
        removeLocalConfigName(localConfig, kind, name);
      } else {
        removeManifestName(manifest, kind, name);
      }

      const entry = oldLock.items[dataKey(kind, name)];
      if (entry?.source !== "data") {
        throw new Error(`expected data lock entry for data/${kind}/${name}`);
      }
      delete lock.items[dataKey(kind, name)];

      let path = "";
      let removed = false;
      if (isFragmentItemKind(kind)) {
        const dataRepo = await resolveProjectDataRepo(
          project,
          oldManifest,
          cmd,
        );
        const targets = await lockedFragmentTargetsForItem(
          dataRepo,
          kind,
          name,
          entry,
          oldManifest,
        );
        path = targets[0] ? fragmentOutputPath(project, targets[0]) : "";
        for (const target of targets) {
          const result = await applyFragmentOutput({
            project,
            dataRepo,
            manifest,
            oldManifest,
            nextManifest: manifest,
            oldLock,
            nextLock: lock,
            target,
          });
          removed = removed || result.action === "reconciled";
        }
      } else if (isCopyDirectoryItemKind(kind)) {
        path = installedPath(project, kind, name, manifest.installMode);
        removed = await removeInstallAliases(
          project,
          kind,
          name,
          path,
          manifest.installMode,
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
        throw new PreconditionError(
          `rm is not implemented for copy-target-file item ${kind}/${name}`,
        );
      } else {
        throw new Error(`no removal strategy for ${kind}/${name}`);
      }

      if (opts.local) {
        if (!localConfig) throw new Error("expected local manifest");
        await removeLocalExcludes(project, kind, name);
        await saveLocalConfig(project, localConfig);
        await saveLocalLock(project, lock);
      } else {
        await saveManifest(project, manifest);
        await saveLock(project, lock);
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
