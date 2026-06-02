import type { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isFragmentItemKind, shaOfGitVisibleItem } from "../master";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadLock, dataKey, systemKey } from "../lock";
import { loadManifest } from "../manifest";
import { findSystemItem, shaOfSystemItem } from "../bundled";
import { assertIsGitRepo, gitVisibleFilesUnderPath } from "../git";
import { globalOpts } from "../cli";
import { NotFoundError, PreconditionError } from "../errors";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { isIgnoredDotEntry } from "../dotfiles";
import {
  currentFragmentSourcesForItem,
  fragmentOutputPath,
  shaOfFragmentItem,
  sourceMatchesCliTarget,
  sourceTargetForCli,
} from "../fragments";

interface ShowOptions {
  json?: boolean;
  content?: boolean;
  target?: string;
}

export function registerShow(program: Command): void {
  program
    .command("show <item>")
    .description("print metadata and content for an item (data or system)")
    .option(
      "--target <target>",
      "fragment target for mcp items: claude or codex",
    )
    .option("--json", "output JSON (no content dump)")
    .option("--no-content", "skip content dump")
    .action(async (itemRef: string, opts: ShowOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);

      const systemItem = findSystemItem(ref.name);
      if (
        systemItem &&
        (ref.kind === undefined || systemItem.kind === ref.kind)
      ) {
        await showSystem(ref.name, lock, opts);
        return;
      }

      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);
      const item = await findMasterItemByRef(dataRepo, ref);
      if (!item) {
        throw new NotFoundError(`not found: ${itemRef}`);
      }
      const cliTarget = sourceTargetForCli(opts.target);
      if (!isFragmentItemKind(item.kind) && cliTarget) {
        throw new PreconditionError("--target is only valid for mcp fragments");
      }
      if (isFragmentItemKind(item.kind) && item.kind !== "mcp" && cliTarget) {
        throw new PreconditionError("--target is only valid for mcp fragments");
      }
      const fragmentSources = isFragmentItemKind(item.kind)
        ? (
            await currentFragmentSourcesForItem(dataRepo, item.kind, item.name)
          ).filter((source) => sourceMatchesCliTarget(source, cliTarget))
        : [];
      if (isFragmentItemKind(item.kind) && fragmentSources.length === 0) {
        throw new PreconditionError(
          `no matching fragment source for ${itemRef}`,
        );
      }
      const masterSha = isFragmentItemKind(item.kind)
        ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
        : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
      const lockEntry = lock.items[dataKey(item.kind, item.name)] ?? null;

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              source: "data",
              kind: item.kind,
              name: item.name,
              path: item.path,
              masterSha,
              lockedSha: lockEntry?.sha ?? null,
              ...(fragmentSources.length > 0 && {
                sources: fragmentSources.map((source) => ({
                  target: source.sourceTarget ?? source.target,
                  sourcePath: source.relPath,
                  outputPath: relativeProjectPath(
                    project,
                    fragmentOutputPath(project, source.target),
                  ),
                })),
              }),
              sourceCommit:
                lockEntry?.source === "data" ? lockEntry.sourceCommit : null,
              label:
                lockEntry?.source === "data" ? (lockEntry.label ?? null) : null,
              appliedAt: lockEntry?.appliedAt ?? null,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`data/${item.kind}/${item.name}`);
      console.log(`  master sha: ${masterSha}`);
      if (lockEntry) {
        const drift = lockEntry.sha !== masterSha ? " (update available)" : "";
        console.log(`  locked sha: ${lockEntry.sha}${drift}`);
        if (lockEntry.source === "data") {
          console.log(`  source commit: ${lockEntry.sourceCommit}`);
          if (lockEntry.label) console.log(`  label:      ${lockEntry.label}`);
        }
        console.log(`  applied:    ${lockEntry.appliedAt}`);
      } else {
        console.log(`  not installed in this project`);
      }
      console.log(`  path:       ${item.path}`);

      if (opts.content === false) return;

      if (isFragmentItemKind(item.kind)) {
        for (const source of fragmentSources) {
          console.log(`─── ${source.relPath} ─────────────────────`);
          console.log(
            await readFile(
              join(dataRepo, ...source.relPath.split("/")),
              "utf-8",
            ),
          );
        }
        return;
      }

      const info = await stat(item.path);
      if (info.isFile()) {
        console.log(`─── ${item.name} ─────────────────────`);
        console.log(await readFile(item.path, "utf-8"));
      } else {
        const files = await gitVisibleFilesUnderPath(
          dataRepo,
          item.repoRelPath,
        );
        for (const file of files) {
          if (file.includes("/")) continue;
          if (isIgnoredDotEntry(file)) continue;
          console.log(`─── ${file} ─────────────────────`);
          console.log(await readFile(join(item.path, file), "utf-8"));
        }
      }
    });
}

function relativeProjectPath(project: string, path: string): string {
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}

async function showSystem(
  name: string,
  lock: Awaited<ReturnType<typeof loadLock>>,
  opts: ShowOptions,
): Promise<void> {
  const item = findSystemItem(name);
  if (!item) {
    throw new NotFoundError(`system item not found: ${name}`);
  }
  const bundledSha = await shaOfSystemItem(item);
  const lockEntry = lock.items[systemKey(item.kind, item.name)] ?? null;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          source: "system",
          kind: item.kind,
          name: item.name,
          bundledSha,
          lockedSha: lockEntry?.sha ?? null,
          cliVersion:
            lockEntry?.source === "system" ? lockEntry.cliVersion : null,
          appliedAt: lockEntry?.appliedAt ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`system/${item.kind}/${item.name}`);
  console.log(`  bundled sha: ${bundledSha}`);
  if (lockEntry) {
    const drift =
      lockEntry.sha !== bundledSha ? " (cli upgraded — run apply)" : "";
    console.log(`  locked sha:  ${lockEntry.sha}${drift}`);
    if (lockEntry.source === "system") {
      console.log(`  cli version: ${lockEntry.cliVersion}`);
    }
    console.log(`  applied:     ${lockEntry.appliedAt}`);
  } else {
    console.log(`  not installed in this project`);
  }

  if (opts.content === false) return;
  for (const f of item.files) {
    console.log(`─── ${f.relPath} ─────────────────────`);
    console.log(f.content);
  }
}
