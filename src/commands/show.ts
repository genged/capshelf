import { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { shaOfGitVisibleItem } from "../master";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadLock, dataKey, systemKey } from "../lock";
import { loadManifest } from "../manifest";
import { findSystemItem, shaOfSystemItem } from "../bundled";
import { assertIsGitRepo, gitVisibleFilesUnderPath } from "../git";
import { globalOpts } from "../cli";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { isIgnoredDotEntry } from "../dotfiles";

interface ShowOptions {
  json?: boolean;
  content?: boolean;
}

export function registerShow(program: Command): void {
  program
    .command("show <item>")
    .description("print metadata and content for an item (data or system)")
    .option("--json", "output JSON (no content dump)")
    .option("--no-content", "skip content dump")
    .action(async (itemRef: string, opts: ShowOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);

      const systemItem = findSystemItem(ref.name);
      if (systemItem && (ref.kind === undefined || systemItem.kind === ref.kind)) {
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
        console.error(`✗ not found: ${itemRef}`);
        process.exit(2);
      }
      const masterSha = await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
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
              sourceCommit:
                lockEntry?.source === "data" ? lockEntry.sourceCommit : null,
              label:
                lockEntry?.source === "data"
                  ? (lockEntry.label ?? null)
                  : null,
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
        const drift =
          lockEntry.sha !== masterSha ? " (update available)" : "";
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

      const info = await stat(item.path);
      if (info.isFile()) {
        console.log(`─── ${item.name} ─────────────────────`);
        console.log(await readFile(item.path, "utf-8"));
      } else {
        const files = await gitVisibleFilesUnderPath(dataRepo, item.repoRelPath);
        for (const file of files) {
          if (file.includes("/")) continue;
          if (isIgnoredDotEntry(file)) continue;
          console.log(`─── ${file} ─────────────────────`);
          console.log(await readFile(join(item.path, file), "utf-8"));
        }
      }
    });
}

async function showSystem(
  name: string,
  lock: Awaited<ReturnType<typeof loadLock>>,
  opts: ShowOptions,
): Promise<void> {
  const item = findSystemItem(name);
  if (!item) {
    console.error(`✗ system item not found: ${name}`);
    process.exit(2);
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
