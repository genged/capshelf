import type { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isFragmentItemKind, shaOfGitVisibleItem } from "../master";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadLocalLock, loadLock, dataKey, systemKey } from "../lock";
import type { Lock } from "../lock";
import { loadManifest } from "../manifest";
import {
  loadDataItemMetadata,
  loadSystemItemMetadata,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata } from "../metadata";
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
      const localLock = await loadLocalLock(project);

      const systemItem = findSystemItem(ref.name);
      if (
        systemItem &&
        (ref.kind === undefined || systemItem.kind === ref.kind)
      ) {
        await showSystem(ref.name, lock, localLock, opts);
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
      const meta = await loadDataItemMetadata(item);
      printMetadataWarnings(meta);
      const locks = [lock, localLock];

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
              metadata: metadataJson(meta, locks),
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
      printMetadataBlock(meta, locks);
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
  lock: Lock,
  localLock: Lock,
  opts: ShowOptions,
): Promise<void> {
  const item = findSystemItem(name);
  if (!item) {
    throw new NotFoundError(`system item not found: ${name}`);
  }
  const bundledSha = await shaOfSystemItem(item);
  const lockEntry = lock.items[systemKey(item.kind, item.name)] ?? null;
  const meta = loadSystemItemMetadata(item);
  printMetadataWarnings(meta);
  const locks = [lock, localLock];

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
          metadata: metadataJson(meta, locks),
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
  printMetadataBlock(meta, locks);

  if (opts.content === false) return;
  for (const f of item.files) {
    console.log(`─── ${f.relPath} ─────────────────────`);
    console.log(f.content);
  }
}

interface RelationState {
  ref: string;
  installed: boolean;
}

/**
 * "Installed" means present in either capshelf.lock.json or local.lock.json,
 * under either the data or system source prefix.
 */
function relationStates(refs: string[], locks: Lock[]): RelationState[] {
  return refs.map((ref) => ({
    ref,
    installed: locks.some(
      (lock) =>
        lock.items[`data/${ref}`] !== undefined ||
        lock.items[`system/${ref}`] !== undefined,
    ),
  }));
}

/** The always-present `metadata` JSON object appended to show --json. */
function metadataJson(
  meta: ItemMetadata,
  locks: Lock[],
): {
  description?: string;
  tags: string[];
  requires: RelationState[];
  conflictsWith: RelationState[];
} {
  return {
    ...(meta.description !== undefined && { description: meta.description }),
    tags: meta.tags,
    requires: relationStates(meta.requires, locks),
    conflictsWith: relationStates(meta.conflictsWith, locks),
  };
}

function printMetadataBlock(meta: ItemMetadata, locks: Lock[]): void {
  if (meta.description !== undefined) {
    console.log(`  description: ${meta.description}`);
  }
  if (meta.tags.length > 0) {
    console.log(`  tags:        ${meta.tags.join(", ")}`);
  }
  for (const [label, refs] of [
    ["requires:   ", meta.requires],
    ["conflicts:  ", meta.conflictsWith],
  ] as const) {
    if (refs.length === 0) continue;
    const states = relationStates(refs, locks)
      .map(
        (rel) =>
          `${rel.ref} (${rel.installed ? "installed" : "not installed"})`,
      )
      .join(", ");
    console.log(`  ${label} ${states}`);
  }
}
