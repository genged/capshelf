import type { Command } from "commander";
import { rm as fsRm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { projectRoot, resolveDataRepo } from "../paths";
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
import { isFragmentItemKind, ITEM_KINDS } from "../master";
import {
  installedPath,
  parseLockKey,
  removeInstallAliases,
} from "../installed";
import { isSystemItemName } from "../bundled";
import { lockKeysForRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../cli";
import { loadLocalConfig, saveLocalConfig } from "../local-config";
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
      if (isSystemItemName(ref.name)) {
        console.error(
          `✗ "${ref.name}" is a system item — managed by the CLI, cannot be removed. It will be re-installed by 'capshelf init' anyway.`,
        );
        process.exit(3);
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = opts.local
        ? await loadLocalLock(project)
        : await loadLock(project);
      const localConfig = opts.local ? await loadLocalConfig(project) : null;
      const oldManifest = cloneJson(manifest);
      const oldLock = cloneJson(lock);

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
          console.error(
            `✗ not removing skills/${ref.name} — ${skillsShConflictMessage(external)}`,
          );
          process.exit(3);
        }
      }

      if (dataKeys.length > 1) {
        throw new Error(
          `ambiguous item "${ref.name}": found ${dataKeys
            .map((key) => {
              const parsed = parseLockKey(key);
              return `${parsed.kind}/${parsed.name}`;
            })
            .join(", ")}; use kind/name`,
        );
      }

      if (dataKeys.length === 0) {
        const manifestKinds = ITEM_KINDS.filter(
          (k) =>
            (!ref.kind || k === ref.kind) &&
            manifestNamesForKind(manifest, k).includes(ref.name),
        );
        if (manifestKinds.length > 0) {
          const label = ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
          console.error(
            `✗ not removing ${label} — no data lock entry exists, so installed files are not managed by capshelf`,
          );
          console.error(
            "  remove local-only files manually, or repair the lock before running capshelf rm",
          );
          process.exit(3);
        }
        console.error(`✗ not installed in this project: ${itemRef}`);
        process.exit(2);
      }

      const parsed = parseLockKey(dataKeys[0]!);
      const kind = parsed.kind as ItemKind;
      const name = parsed.name;
      if (opts.local && isFragmentItemKind(kind)) {
        console.error(`✗ --local is not supported for ${kind} fragments`);
        process.exit(3);
      }
      if (opts.local) {
        if (!localConfig) throw new Error("no local manifest exists");
        if (kind !== "skills") {
          console.error("✗ --local currently supports skills only");
          process.exit(3);
        }
        localConfig.skills = localConfig.skills.filter((x) => x !== name);
      } else {
        removeManifestName(manifest, kind, name);
      }

      const entry = oldLock.items[dataKey(kind, name)];
      if (entry?.source !== "data") {
        throw new Error(`expected data lock entry for data/${kind}/${name}`);
      }
      delete lock.items[dataKey(kind, name)];

      let path = isFragmentItemKind(kind)
        ? ""
        : installedPath(project, kind, name, manifest.installMode);
      let removed = false;
      if (isFragmentItemKind(kind)) {
        const dataRepo = await resolveDataRepo({
          override: globalOpts(cmd).data,
          manifest: oldManifest,
          project,
        });
        await assertIsGitRepo(dataRepo);
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
      } else {
        removed = await removeInstallAliases(
          project,
          kind,
          name,
          path,
          manifest.installMode,
        );
        if (existsSync(path)) {
          await fsRm(path, { recursive: true, force: true });
          removed = true;
        }
      }

      if (opts.local) {
        if (!localConfig) throw new Error("expected local manifest");
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
