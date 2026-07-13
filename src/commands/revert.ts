import type { Command } from "commander";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadManifest } from "../manifest";
import { loadLocalLock, loadLock, saveLocalLock, saveLock } from "../lock";
import { parseLockKey } from "../installed";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../global-options";
import { NotFoundError, PreconditionError } from "../errors";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { materializeLockEntry } from "../materialize";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import { printRuntimeWarnings } from "../runtime-warnings";
import {
  applyFragmentOutput,
  isFragmentKind,
  lockedFragmentTargetsForItem,
} from "../fragments";

interface RevertOptions {
  json?: boolean;
  local?: boolean;
}

export function registerRevert(program: Command): void {
  program
    .command("revert <item>")
    .description("discard local edits by reapplying locked content")
    .option("--local", "revert a local-scope item")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: RevertOptions, cmd: Command) => {
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = opts.local
        ? await loadLocalLock(project)
        : await loadLock(project);
      const ref = parseItemRef(itemRef);
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

      const entry = lock.items[key]!;
      if (entry.source === "data") {
        delete entry.local;
        delete entry.localReason;
      }

      if (isFragmentKind(parsed.kind)) {
        if (opts.local) {
          throw new PreconditionError(
            `--local is not supported for ${parsed.kind} fragments`,
          );
        }
        if (!dataRepo) throw new Error("data repo is required");
        const targets =
          entry.source === "data"
            ? await lockedFragmentTargetsForItem(
                dataRepo,
                parsed.kind,
                parsed.name,
                entry,
                manifest,
              )
            : [];
        const results = [];
        for (const target of targets) {
          results.push(
            await applyFragmentOutput({
              project,
              dataRepo,
              manifest,
              oldLock: lock,
              nextLock: lock,
              target,
            }),
          );
        }

        if (opts.local) await saveLocalLock(project, lock);
        else await saveLock(project, lock);

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }
        console.log(
          `✓ reverted ${opts.local ? "local/" : ""}${parsed.source}/${parsed.kind}/${parsed.name}`,
        );
        for (const result of results) console.log(`  ${result.path}`);
        return;
      }

      const result = await materializeLockEntry({
        project,
        dataRepo,
        manifest,
        key,
        entry,
        ignoreLocal: true,
      });

      if (opts.local) await saveLocalLock(project, lock);
      else await saveLock(project, lock);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `✓ reverted ${opts.local ? "local/" : ""}${parsed.source}/${parsed.kind}/${parsed.name}`,
      );
      console.log(`  ${result.path}`);
      printRuntimeWarnings(result.runtimeWarnings);
    });
}
