import { Command } from "commander";
import {
  projectRoot,
  resolveDataRepo,
  resolveDataRepoOptional,
  homeRelative,
} from "../paths";
import { CLI_VERSION } from "../bundled";
import { listMasterItems, ITEM_KINDS, shaOfGitVisibleItem } from "../master";
import type { ItemKind } from "../master";
import { loadLock } from "../lock";
import { loadManifest } from "../manifest";
import { parseLockKey } from "../installed";
import { SYSTEM_ITEMS, shaOfSystemItem } from "../bundled";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../cli";

interface LsOptions {
  here?: boolean;
  json?: boolean;
  kind?: string;
}

export function registerLs(program: Command): void {
  program
    .command("ls")
    .description("list available items (data repo + system) or installed items with --here")
    .option("--here", "list items installed in the current project")
    .option("--json", "output JSON")
    .option("-k, --kind <kind>", "filter by kind (skills|settings|mcp)")
    .action(async (opts: LsOptions, cmd: Command) => {
      if (opts.kind && !ITEM_KINDS.includes(opts.kind as ItemKind)) {
        throw new Error(
          `invalid kind "${opts.kind}"; must be one of ${ITEM_KINDS.join(", ")}`,
        );
      }
      const kindFilter = opts.kind as ItemKind | undefined;

      if (opts.here) {
        await lsHere(kindFilter, opts.json ?? false);
      } else {
        const project = projectRoot();
        const manifest = await loadManifest(project);
        const dataRepo = await resolveDataRepo({
          override: globalOpts(cmd).data,
          manifest,
          project,
        });
        await lsAvailable(dataRepo, kindFilter, opts.json ?? false);
      }
    });
}

async function lsAvailable(
  dataRepo: string,
  kind: ItemKind | undefined,
  json: boolean,
): Promise<void> {
  // Was previously catching errors and returning [] — that hid bad bindings as
  // "no data items." Let the assertion / listMasterItems surface real errors.
  await assertIsGitRepo(dataRepo);
  const dataItems = await listMasterItems(dataRepo, kind);
  const systemItems = SYSTEM_ITEMS.filter((s) => !kind || s.kind === kind);

  if (json) {
    const sysRows = await Promise.all(
      systemItems.map(async (i) => ({
        source: "system" as const,
        kind: i.kind,
        name: i.name,
        sha: await shaOfSystemItem(i),
      })),
    );
    const dataRows = await Promise.all(
      dataItems.map(async (i) => ({
        source: "data" as const,
        kind: i.kind,
        name: i.name,
        sha: await shaOfGitVisibleItem(dataRepo, i.repoRelPath),
        path: i.path,
      })),
    );
    console.log(
      JSON.stringify({ dataRepo, system: sysRows, data: dataRows }, null, 2),
    );
    return;
  }

  if (systemItems.length > 0) {
    console.log(`system/  (bundled in capshelf ${CLI_VERSION})`);
    for (const i of systemItems) {
      const sha = await shaOfSystemItem(i);
      console.log(`  ${i.kind}/${i.name.padEnd(26)} ${sha}`);
    }
    console.log("");
  }

  console.log(`data/  (from ${homeRelative(dataRepo)})`);
  if (dataItems.length === 0) {
    console.log("  (none)");
    return;
  }

  const byKind = new Map<ItemKind, typeof dataItems>();
  for (const i of dataItems) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind)!.push(i);
  }
  for (const k of ITEM_KINDS) {
    const list = byKind.get(k);
    if (!list || list.length === 0) continue;
    for (const i of list) {
      const sha = await shaOfGitVisibleItem(dataRepo, i.repoRelPath);
      console.log(`  ${i.kind}/${i.name.padEnd(26)} ${sha}`);
    }
  }
}

async function lsHere(kind: ItemKind | undefined, json: boolean): Promise<void> {
  const project = projectRoot();
  const manifest = await loadManifest(project);
  const lock = await loadLock(project);
  const entries = Object.entries(lock.items).map(([key, entry]) => {
    const { kind: k, name } = parseLockKey(key);
    return { kind: k, name, ...entry };
  });
  const filtered = kind ? entries.filter((e) => e.kind === kind) : entries;

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("(no items installed in this project)");
    return;
  }
  console.log(project);
  console.log("");

  const system = filtered.filter((e) => e.source === "system");
  const data = filtered.filter((e) => e.source === "data");
  const dataRepo = await resolveDataRepoOptional({ manifest, project });
  const dataRepoLabel = dataRepo ? homeRelative(dataRepo) : null;

  if (system.length > 0) {
    console.log(`system/  (bundled in capshelf ${CLI_VERSION})`);
    for (const e of system) {
      console.log(`  ${e.kind}/${e.name.padEnd(26)} ${e.sha}`);
    }
    if (data.length > 0) console.log("");
  }
  if (data.length > 0) {
    const dataHeader = dataRepoLabel
      ? `data/  (from ${dataRepoLabel})`
      : "data/  (no data repo bound - run set-data <path>)";
    console.log(dataHeader);
    for (const e of data) {
      const label =
        e.source === "data" && "label" in e && e.label ? ` ${e.label}` : "";
      console.log(`  ${e.kind}/${e.name.padEnd(26)} ${e.sha}${label}`);
    }
  }
}
