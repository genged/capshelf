import type { Command } from "commander";
import { join } from "node:path";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadLock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { loadManifest } from "../manifest";
import { globalOpts } from "../cli";
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
        console.error(`✗ not tracked in this project: ${itemRef}`);
        process.exit(2);
      }

      const parsed = parseLockKey(key);
      const cliTarget = sourceTargetForCli(opts.target);
      if (!isFragmentKind(parsed.kind) && (opts.output || cliTarget)) {
        console.error(
          "✗ --output and --target are only valid for fragment items",
        );
        process.exit(3);
      }
      if (isFragmentKind(parsed.kind) && parsed.kind !== "mcp" && cliTarget) {
        console.error("✗ --target is only valid for mcp fragments");
        process.exit(3);
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
          console.error(
            `✗ ${parsed.kind}/${parsed.name} does not have target ${opts.target ?? ""}`,
          );
          process.exit(3);
        }
        if (sources.length > 1) {
          console.error(
            `✗ mcp/${parsed.name} has multiple targets; pass --target claude or --target codex`,
          );
          process.exit(3);
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
