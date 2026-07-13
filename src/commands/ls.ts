import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, projectRoot, homeRelative } from "../paths";
import { resolveDataRepo, resolveDataRepoOptional } from "../data-repo";
import { PreconditionError } from "../errors";
import { CLI_VERSION } from "../bundled";
import {
  isFragmentItemKind,
  itemRepoRelPath,
  listMasterItems,
  ITEM_KINDS,
  shaOfGitVisibleItem,
} from "../master";
import type { ItemKind } from "../master";
import { loadLocalLock, loadLock } from "../lock";
import { loadManifest } from "../manifest";
import { parseLockKey } from "../installed";
import { SYSTEM_ITEMS, findSystemItem, shaOfSystemItem } from "../bundled";
import { assertIsGitRepo } from "../git";
import { globalOpts } from "../global-options";
import { shaOfFragmentItem } from "../fragments";
import {
  loadDataItemMetadata,
  loadSystemItemMetadata,
  matchesTagFilter,
  metadataLineSuffix,
  printMetadataWarnings,
} from "../metadata";
import type { ItemMetadata } from "../metadata";
import { assertNoScopeCollisions } from "../status-core";
import { listBundles, memberCountSummary, memberRef } from "../bundles";
import type { Bundle } from "../bundles";
import {
  listUserSkills,
  withUserSkillShadows,
  type ExternalUserSkill,
} from "../external";
import { formatUserSkillsHuman } from "../status-format";

interface LsOptions {
  here?: boolean;
  user?: boolean;
  json?: boolean;
  kind?: string;
  tag: string[];
}

export function registerLs(program: Command): void {
  program
    .command("ls")
    .description(
      "list available items (data repo + system) or installed items with --here",
    )
    .option("--here", "list items installed in the current project")
    .option("--user", "list user-level runtime skills")
    .option("--json", "output JSON")
    .option(
      "-k, --kind <kind>",
      "filter by kind (skills|settings|mcp|codex-config)",
    )
    .option(
      "--tag <tag>",
      "filter by tag (repeatable; repeated tags narrow with AND)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts: LsOptions, cmd: Command) => {
      if (opts.kind && !ITEM_KINDS.includes(opts.kind as ItemKind)) {
        throw new PreconditionError(
          `invalid kind "${opts.kind}"; must be one of ${ITEM_KINDS.join(", ")}`,
        );
      }
      const kindFilter = opts.kind as ItemKind | undefined;

      if (opts.here && opts.user) {
        throw new PreconditionError(
          "--here and --user cannot be used together",
        );
      }

      if (opts.user) {
        await lsUser(kindFilter, opts.tag, opts.json ?? false);
      } else if (opts.here) {
        await lsHere(kindFilter, opts.tag, opts.json ?? false);
      } else {
        // Browse-only: works inside a project (uses its binding) or anywhere
        // with --data / $CAPSHELF_HOME, so a shelf can be evaluated before it
        // is adopted.
        const project = findProjectRoot();
        const manifest = project ? await loadManifest(project) : null;
        const dataRepo = await resolveDataRepo({
          override: globalOpts(cmd).data,
          manifest,
          project: project ?? undefined,
        });
        await lsAvailable(
          project,
          dataRepo,
          kindFilter,
          opts.tag,
          opts.json ?? false,
        );
      }
    });
}

async function lsAvailable(
  project: string | null,
  dataRepo: string,
  kind: ItemKind | undefined,
  tags: string[],
  json: boolean,
): Promise<void> {
  // Was previously catching errors and returning [] — that hid bad bindings as
  // "no data items." Let the assertion / listMasterItems surface real errors.
  await assertIsGitRepo(dataRepo);
  const dataItems = await listMasterItems(dataRepo, kind);
  const systemItems = SYSTEM_ITEMS.filter((s) => !kind || s.kind === kind);

  const systemRows = systemItems
    .map((item) => ({ item, meta: loadSystemItemMetadata(item) }))
    .filter(({ meta }) => matchesTagFilter(meta, tags));
  const dataRows = (
    await Promise.all(
      dataItems.map(async (item) => ({
        item,
        meta: await loadDataItemMetadata(item),
      })),
    )
  ).filter(({ meta }) => matchesTagFilter(meta, tags));
  for (const { meta } of [...systemRows, ...dataRows]) {
    printMetadataWarnings(meta);
  }

  // Bundles are not a kind, so the section is suppressed under --kind;
  // reads warn-and-degrade (a malformed bundle stays visible, name-only).
  let bundleRows: Bundle[] = [];
  if (!kind) {
    const listing = await listBundles(dataRepo);
    for (const warning of listing.warnings) console.error(`⚠ ${warning}`);
    for (const bundle of listing.bundles) {
      for (const warning of new Set(bundle.warnings)) {
        console.error(`⚠ ${warning}`);
      }
    }
    bundleRows = listing.bundles.filter((bundle) =>
      matchesTagFilter(bundleMeta(bundle), tags),
    );
  }
  const externalUserSkills =
    tags.length === 0 && (!kind || kind === "skills")
      ? await userSkillsWithProjectShadows(project)
      : [];

  if (json) {
    const sysRows = await Promise.all(
      systemRows.map(async ({ item, meta }) => ({
        source: "system" as const,
        kind: item.kind,
        name: item.name,
        sha: await shaOfSystemItem(item),
        ...metadataJsonFields(meta),
      })),
    );
    const dataJsonRows = await Promise.all(
      dataRows.map(async ({ item, meta }) => ({
        source: "data" as const,
        kind: item.kind,
        name: item.name,
        sha: await shaOfDataItem(dataRepo, item),
        path: item.path,
        ...metadataJsonFields(meta),
      })),
    );
    console.log(
      JSON.stringify(
        {
          dataRepo,
          system: sysRows,
          data: dataJsonRows,
          externalUserSkills,
          // Append-only: a sibling top-level key; system/data rows unchanged.
          ...(bundleRows.length > 0 && {
            bundles: bundleRows.map((bundle) => ({
              name: bundle.name,
              path: bundle.path,
              ...metadataJsonFields(bundleMeta(bundle)),
              members: bundle.members.map(memberRef),
              ...(bundle.malformed !== undefined && {
                malformed: bundle.malformed,
              }),
            })),
          }),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (systemRows.length > 0) {
    console.log(`system/  (bundled in capshelf ${CLI_VERSION})`);
    for (const { item, meta } of systemRows) {
      const sha = await shaOfSystemItem(item);
      console.log(
        `  ${item.kind}/${item.name.padEnd(26)} ${sha}${metadataLineSuffix(meta)}`,
      );
    }
    console.log("");
  }

  console.log(`data/  (from ${homeRelative(dataRepo)})`);
  if (dataRows.length === 0) {
    console.log("  (none)");
  }

  const byKind = new Map<ItemKind, typeof dataRows>();
  for (const row of dataRows) {
    if (!byKind.has(row.item.kind)) byKind.set(row.item.kind, []);
    byKind.get(row.item.kind)?.push(row);
  }
  for (const k of ITEM_KINDS) {
    const list = byKind.get(k);
    if (!list || list.length === 0) continue;
    for (const { item, meta } of list) {
      const sha = await shaOfDataItem(dataRepo, item);
      console.log(
        `  ${item.kind}/${item.name.padEnd(26)} ${sha}${metadataLineSuffix(meta)}`,
      );
    }
  }

  if (bundleRows.length > 0) {
    console.log("");
    console.log(`bundles/  (from ${homeRelative(dataRepo)})`);
    for (const bundle of bundleRows) {
      // Malformed bundles list name-only so someone fixes them.
      const counts = bundle.malformed ? "" : memberCountSummary(bundle);
      const line = `  ${bundle.name.padEnd(33)}${counts ? ` ${counts}` : ""}${metadataLineSuffix(bundleMeta(bundle))}`;
      console.log(line.trimEnd());
    }
  }

  if (externalUserSkills.length > 0) {
    console.log("");
    console.log(formatUserSkillsHuman(externalUserSkills).join("\n"));
  }
}

async function lsUser(
  kind: ItemKind | undefined,
  tags: string[],
  json: boolean,
): Promise<void> {
  if (tags.length > 0) {
    throw new PreconditionError("--tag is not supported with --user");
  }

  const project = currentProjectRootOrNull();
  const skills =
    kind && kind !== "skills"
      ? []
      : await userSkillsWithProjectShadows(project);

  if (json) {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  console.log(formatUserSkillsHuman(skills).join("\n"));
}

async function userSkillsWithProjectShadows(
  project: string | null,
): Promise<ExternalUserSkill[]> {
  const skills = await listUserSkills();
  if (!project) return skills;
  const projectLock = await loadLock(project);
  const localLock = await loadLocalLock(project);
  return withUserSkillShadows(skills, projectLock, localLock);
}

function currentProjectRootOrNull(): string | null {
  return findProjectRoot();
}

/** Bundle description/tags shaped as item metadata for shared helpers. */
function bundleMeta(bundle: Bundle): ItemMetadata {
  return {
    ...(bundle.description !== undefined && {
      description: bundle.description,
    }),
    tags: bundle.tags,
    requires: [],
    conflictsWith: [],
    warnings: [],
  };
}

function metadataJsonFields(meta: ItemMetadata): {
  description?: string;
  tags?: string[];
} {
  return {
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.tags.length > 0 && { tags: meta.tags }),
  };
}

async function shaOfDataItem(
  dataRepo: string,
  item: { kind: ItemKind; name: string; repoRelPath: string },
): Promise<string> {
  return isFragmentItemKind(item.kind)
    ? await shaOfFragmentItem(dataRepo, item.kind, item.name)
    : await shaOfGitVisibleItem(dataRepo, item.repoRelPath);
}

/**
 * Best-effort metadata for an installed row. The sidecar is never
 * materialized, so the bound data repo's working tree is the only source;
 * an unbound clone or a missing upstream item must not break `ls --here`.
 */
async function installedRowMetadata(
  dataRepo: string | null,
  source: "data" | "system",
  kind: ItemKind,
  name: string,
): Promise<ItemMetadata | null> {
  try {
    if (source === "system") {
      const item = findSystemItem(name);
      if (!item || item.kind !== kind) return null;
      return loadSystemItemMetadata(item);
    }
    if (!dataRepo) return null;
    const path = join(dataRepo, ...itemRepoRelPath(kind, name).split("/"));
    if (!existsSync(path)) return null;
    return await loadDataItemMetadata({ kind, name, path });
  } catch {
    return null;
  }
}

async function lsHere(
  kind: ItemKind | undefined,
  tags: string[],
  json: boolean,
): Promise<void> {
  const project = projectRoot();
  const manifest = await loadManifest(project);
  const projectLock = await loadLock(project);
  const localLock = await loadLocalLock(project);
  assertNoScopeCollisions(projectLock, localLock);

  const projectEntries = Object.entries(projectLock.items).map(
    ([key, entry]) => {
      const { kind: k, name } = parseLockKey(key);
      return { scope: "project" as const, kind: k, name, ...entry };
    },
  );
  const localEntries = Object.entries(localLock.items).map(([key, entry]) => {
    const { kind: k, name } = parseLockKey(key);
    return { scope: "local" as const, kind: k, name, ...entry };
  });
  const entries = [...projectEntries, ...localEntries];
  const kindFiltered = kind ? entries.filter((e) => e.kind === kind) : entries;
  const dataRepo = await resolveDataRepoOptional({ manifest, project });

  const rows: Array<{
    entry: (typeof kindFiltered)[number];
    meta: ItemMetadata | null;
  }> = [];
  for (const entry of kindFiltered) {
    const meta = await installedRowMetadata(
      dataRepo,
      entry.source,
      entry.kind,
      entry.name,
    );
    if (!matchesTagFilter(meta, tags)) continue;
    if (meta) printMetadataWarnings(meta);
    rows.push({ entry, meta });
  }

  if (json) {
    console.log(
      JSON.stringify(
        rows.map(({ entry, meta }) => ({
          ...entry,
          ...(meta ? metadataJsonFields(meta) : {}),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (rows.length === 0) {
    console.log("(no items installed in this project)");
    return;
  }
  console.log(project);
  console.log("");

  const system = rows.filter(
    ({ entry }) => entry.scope === "project" && entry.source === "system",
  );
  const projectData = rows.filter(
    ({ entry }) => entry.scope === "project" && entry.source === "data",
  );
  const localData = rows.filter(
    ({ entry }) => entry.scope === "local" && entry.source === "data",
  );
  const dataRepoLabel = dataRepo ? homeRelative(dataRepo) : null;
  let printedSection = false;

  if (system.length > 0) {
    console.log(`system/  (bundled in capshelf ${CLI_VERSION})`);
    for (const { entry, meta } of system) {
      console.log(
        `  ${entry.kind}/${entry.name.padEnd(26)} ${entry.sha}${meta ? metadataLineSuffix(meta) : ""}`,
      );
    }
    printedSection = true;
  }

  for (const section of [
    { label: "data", rows: projectData },
    { label: "local/data", rows: localData },
  ]) {
    if (section.rows.length === 0) continue;
    if (printedSection) console.log("");
    const header = dataRepoLabel
      ? `${section.label}/  (from ${dataRepoLabel})`
      : `${section.label}/  (no data repo bound - run set-data <path>)`;
    console.log(header);
    for (const { entry, meta } of section.rows) {
      const label =
        entry.source === "data" && "label" in entry && entry.label
          ? ` ${entry.label}`
          : "";
      console.log(
        `  ${entry.kind}/${entry.name.padEnd(26)} ${entry.sha}${label}${meta ? metadataLineSuffix(meta) : ""}`,
      );
    }
    printedSection = true;
  }
}
