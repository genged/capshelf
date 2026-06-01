import type { Command } from "commander";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { addManifestName, manifestNamesForKind } from "../manifest";
import {
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
  dataKey,
} from "../lock";
import { isFragmentItemKind, shaOfGitVisibleItem } from "../master";
import type { MasterItem } from "../master";
import { copyItemIntoProject, targetDir } from "../sync";
import { findInstallConflict } from "../installed";
import { isSystemItemName } from "../bundled";
import { assertIsGitRepo, assertPathClean, lastTouchingCommit } from "../git";
import { globalOpts } from "../cli";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
  ensureLocalExcludes,
  loadLocalConfig,
  saveLocalConfig,
} from "../local-config";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import {
  applyFragmentOutput,
  assertFragmentSourcesClean,
  currentFragmentSourcesForItem,
  currentFragmentTargetsForItem,
  fragmentOutputPath,
  lastTouchingFragmentCommit,
  shaOfFragmentItem,
} from "../fragments";

interface AddOptions {
  json?: boolean;
  local?: boolean;
}

export function registerAdd(program: Command): void {
  program
    .command("add <item>")
    .description("install an item from the data repo into the current project")
    .option("--local", "install as clone-local project state")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: AddOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        console.error(
          `✗ "${ref.name}" is a system item — managed by the CLI, not addable from a data repo. It is installed automatically by 'capshelf init'.`,
        );
        process.exit(3);
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const projectLock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const lock = opts.local ? localLock : projectLock;
      const oldLock = cloneLock(lock);
      const localConfig = await loadLocalConfig(project);

      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      const item = await findMasterItemByRef(dataRepo, ref);
      if (!item) {
        console.error(`✗ not found in data repo (${dataRepo}): ${itemRef}`);
        process.exit(2);
      }
      if (opts.local && isFragmentItemKind(item.kind)) {
        assertLocalScopeSupported(item.kind, item.name, "add --local");
      }
      if (opts.local)
        assertLocalScopeSupported(item.kind, item.name, "add --local");

      // Refuse to add from a dirty path. Otherwise the locked sha (hashed from
      // working tree) would not match git show <sourceCommit> (the last commit
      // touching the path), leaving apply/revert with the wrong content.
      if (isFragmentItemKind(item.kind)) {
        await assertFragmentSourcesClean(dataRepo, item.kind, item.name);
      } else {
        await assertPathClean(dataRepo, item.repoRelPath);
      }

      const key = dataKey(item.kind, item.name);
      const otherLock = opts.local ? projectLock : localLock;
      if (otherLock.items[key] !== undefined) {
        const otherScope = opts.local ? "project" : "local";
        console.error(
          `✗ ${item.kind}/${item.name} is already owned by ${otherScope} scope; remove one owner before adding another`,
        );
        process.exit(3);
      }
      const alreadyInManifest = opts.local
        ? (localConfig?.skills.includes(item.name) ?? false)
        : manifestNamesForKind(manifest, item.kind).includes(item.name);
      const alreadyInLock = lock.items[key] !== undefined;
      const dst = isFragmentItemKind(item.kind)
        ? fragmentOutputPath(
            project,
            (
              await currentFragmentTargetsForItem(
                dataRepo,
                item.kind,
                item.name,
              )
            )[0]!,
          )
        : targetDir(project, item, manifest.installMode);

      if (item.kind === "skills") {
        const external = await findSkillsShSkill(project, item.name);
        if (external) {
          console.error(
            `✗ not installing ${item.kind}/${item.name} — ${skillsShConflictMessage(external)}`,
          );
          process.exit(3);
        }
      }

      const conflict = isFragmentItemKind(item.kind)
        ? null
        : findInstallConflict(
            project,
            item.kind,
            item.name,
            manifest.installMode,
          );
      if (!alreadyInLock && conflict) {
        console.error(
          `✗ not installing ${item.kind}/${item.name} — target already exists but is not managed by capshelf`,
        );
        console.error(`  existing path: ${conflict}`);
        console.error(
          `  remove it manually, choose a different name, or adopt it with: capshelf share ${item.kind}/${item.name} --to project`,
        );
        process.exit(3);
      }
      if (opts.local) {
        await assertLocalInstallPathsUntracked(project, item.name);
      }

      const sha = isFragmentItemKind(item.kind)
        ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
        : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
      const sourceCommit = isFragmentItemKind(item.kind)
        ? await lastTouchingFragmentCommit(dataRepo, item.kind, item.name)
        : await lastTouchingCommit(dataRepo, item.repoRelPath);

      if (opts.local) {
        if (!localConfig) {
          throw new Error(
            "no local manifest exists; run capshelf init or capshelf set-data first",
          );
        }
        if (!localConfig.skills.includes(item.name))
          localConfig.skills.push(item.name);
      } else {
        addToManifest(manifest, item);
      }
      lock.items[key] = {
        source: "data",
        sha,
        sourceCommit,
        appliedAt: new Date().toISOString(),
      };

      const sources = isFragmentItemKind(item.kind)
        ? await currentFragmentSourcesForItem(dataRepo, item.kind, item.name)
        : [];
      const outputResults: Awaited<ReturnType<typeof applyFragmentOutput>>[] =
        [];
      if (isFragmentItemKind(item.kind)) {
        for (const target of [
          ...new Set(sources.map((source) => source.target)),
        ]) {
          outputResults.push(
            await applyFragmentOutput({
              project,
              dataRepo,
              manifest,
              oldLock,
              nextLock: lock,
              target,
            }),
          );
        }
      } else {
        await copyItemIntoProject(project, item, manifest.installMode);
      }
      const runtimeWarnings = runtimeWarningsForItem(
        project,
        item.kind,
        item.name,
      );

      if (opts.local) {
        if (!localConfig) throw new Error("expected local manifest");
        await ensureLocalExcludes(project, item.name);
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
              kind: item.kind,
              name: item.name,
              scope: opts.local ? "local" : "project",
              sha,
              sourceCommit,
              dst,
              wasAlreadyInstalled: alreadyInManifest && alreadyInLock,
              ...(sources.length > 0 && {
                sources: sources.map((source) => ({
                  target: source.sourceTarget ?? source.target,
                  sourcePath: source.relPath,
                  outputPath: relativeProjectPath(
                    project,
                    fragmentOutputPath(project, source.target),
                  ),
                  outputAction:
                    outputResults.find(
                      (result) => result.target === source.target,
                    )?.action ?? "already-current",
                })),
              }),
              ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
            },
            null,
            2,
          ),
        );
        return;
      }
      const verb = alreadyInManifest && alreadyInLock ? "re-applied" : "added";
      const scope = opts.local ? "local" : "project";
      console.log(`✓ ${verb} ${scope}/data/${item.kind}/${item.name} @ ${sha}`);
      console.log(`  source commit: ${sourceCommit}`);
      console.log(`  ${dst}`);
      printRuntimeWarnings(runtimeWarnings);
    });
}

function addToManifest(m: Manifest, item: MasterItem): void {
  addManifestName(m, item.kind, item.name);
}

function cloneLock<T>(lock: T): T {
  return JSON.parse(JSON.stringify(lock)) as T;
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}
