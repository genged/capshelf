import type { Command } from "commander";
import { join } from "node:path";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadLock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { loadManifest } from "../manifest";
import { globalOpts } from "../cli";
import { NotFoundError, PreconditionError } from "../errors";
import { assertIsGitRepo } from "../git";
import {
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  isFragmentKind,
  sourceMatchesCliTarget,
  sourceTargetForCli,
} from "../fragments";

interface GetPathOptions {
  json?: boolean;
  output?: boolean;
  target?: string;
}

export function registerGetPath(program: Command): void {
  program
    .command("get-path <item>")
    .description(
      "print the installed path for a locked item so it can be edited",
    )
    .option("--output", "print the generated output path for a fragment")
    .option(
      "--target <target>",
      "fragment target for mcp items: claude or codex",
    )
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: GetPathOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);
      const key = lockKeyForRef(lock, ref);
      if (!key) {
        throw new NotFoundError(`not tracked in this project: ${itemRef}`);
      }

      const parsed = parseLockKey(key);
      const cliTarget = sourceTargetForCli(opts.target);
      if (!isFragmentKind(parsed.kind) && (opts.output || cliTarget)) {
        throw new PreconditionError(
          "--output and --target are only valid for fragment items",
        );
      }
      if (isFragmentKind(parsed.kind) && parsed.kind !== "mcp" && cliTarget) {
        throw new PreconditionError("--target is only valid for mcp fragments");
      }

      let path: string;
      let outputPath: string | null = null;
      let sourcePath: string | null = null;
      if (isFragmentKind(parsed.kind)) {
        const dataRepo = await resolveDataRepo({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });
        await assertIsGitRepo(dataRepo);
        const sources = (
          await currentFragmentSourcesForItem(
            dataRepo,
            parsed.kind,
            parsed.name,
          )
        ).filter((source) => sourceMatchesCliTarget(source, cliTarget));
        if (sources.length === 0) {
          throw new PreconditionError(
            `${parsed.kind}/${parsed.name} does not have target ${opts.target ?? ""}`,
          );
        }
        if (sources.length > 1) {
          throw new PreconditionError(
            `mcp/${parsed.name} has multiple targets; pass --target claude or --target codex`,
          );
        }
        const source = sources[0]!;
        sourcePath = join(dataRepo, ...source.relPath.split("/"));
        outputPath = fragmentOutputPath(project, source.target);
        path = opts.output ? outputPath : sourcePath;
      } else {
        path = installedPath(project, parsed.kind, parsed.name);
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: parsed.source,
              kind: parsed.kind,
              name: parsed.name,
              path,
              ...(sourcePath && { sourcePath }),
              ...(outputPath && { outputPath }),
              lock: lock.items[key],
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(path);
    });
}
