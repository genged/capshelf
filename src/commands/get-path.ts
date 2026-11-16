import type { Command } from "commander";
import { join } from "node:path";
import { projectRoot } from "../paths";
import { resolveDataRepo } from "../data-repo";
import { loadLocalLock, loadLock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import { parseItemRef } from "../item-ref";
import { matchRefAcrossScopes } from "../targets";
import { loadManifest } from "../manifest";
import { globalOpts } from "../global-options";
import { PRODUCT_NAME } from "../identity";
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
      const projectLock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const matches = matchRefAcrossScopes(projectLock, localLock, ref);
      if (matches.length === 0) {
        throw new NotFoundError(`not tracked in this project: ${itemRef}`);
      }
      const distinctKeys = [...new Set(matches.map((match) => match.key))];
      if (distinctKeys.length > 1) {
        // Same wording as the one-lock refusal at src/item-ref.ts:110-111. It is a
        // plain Error, so the exit code is 1 (src/cli.ts:128).
        throw new Error(
          `ambiguous item "${ref.name}": found ${distinctKeys
            .map((candidate) => {
              const candidateParsed = parseLockKey(candidate);
              return `${candidateParsed.kind}/${candidateParsed.name}`;
            })
            .join(", ")}; use kind/name`,
        );
      }
      if (matches.length > 1) {
        throw new PreconditionError(
          `${itemRef} is tracked in both project and local scope`,
          {
            hint: `finish the interrupted move: ${PRODUCT_NAME} move ${itemRef} --to local (or --to project)`,
          },
        );
      }
      const { key, scope } = matches[0]!;
      const lock = scope === "local" ? localLock : projectLock;

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
              scope,
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
