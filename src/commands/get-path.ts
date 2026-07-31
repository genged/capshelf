import type { Command } from "commander";
import { join } from "node:path";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadLock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { loadManifest } from "../manifest";
import { globalOpts } from "../global-options";
import { NotFoundError, PreconditionError } from "../errors";
import { assertIsGitRepo } from "../git";
import { isMaterializedItemKind } from "../master";
import {
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  isFragmentKind,
  sourceMatchesCliTarget,
  sourceTargetForCli,
} from "../fragments";
import { currentSubagentSources, isSubagentTarget } from "../subagents";

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
    .option("--output", "print the generated output path")
    .option(
      "--target <target>",
      "runtime target for mcp or subagents: claude or codex",
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
      if (opts.target !== undefined && !isSubagentTarget(opts.target)) {
        throw new PreconditionError(
          `invalid target "${opts.target}"; must be claude or codex`,
        );
      }
      if (
        !isFragmentKind(parsed.kind) &&
        parsed.kind !== "subagents" &&
        (opts.output || cliTarget)
      ) {
        throw new PreconditionError(
          "--output and --target are only valid for fragment items or subagents",
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
      } else if (parsed.kind === "subagents") {
        const dataRepo = await resolveDataRepo({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });
        await assertIsGitRepo(dataRepo);
        const sources = (
          await currentSubagentSources(project, dataRepo, parsed.name)
        ).filter(
          (source) =>
            opts.target === undefined || source.target === opts.target,
        );
        if (sources.length === 0) {
          throw new PreconditionError(
            `subagents/${parsed.name} does not have target ${opts.target ?? ""}`,
          );
        }
        if (sources.length > 1) {
          throw new PreconditionError(
            `subagents/${parsed.name} has multiple targets; pass --target claude or --target codex`,
          );
        }
        const source = sources[0]!;
        sourcePath = join(dataRepo, ...source.relPath.split("/"));
        outputPath = source.outputPath;
        path = opts.output ? outputPath : sourcePath;
      } else if (isMaterializedItemKind(parsed.kind)) {
        path = installedPath(project, parsed.kind, parsed.name);
      } else {
        throw new Error(
          `no installed-path strategy for ${parsed.kind}/${parsed.name}`,
        );
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
