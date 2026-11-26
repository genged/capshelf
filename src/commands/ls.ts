import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  findProjectRoot,
  projectRoot,
  homeRelative,
  detectInstallMode,
  DEFAULT_INSTALL_MODE,
} from "../paths";
import { resolveDataRepo, resolveDataRepoOptional } from "../data-repo";
import { PreconditionError } from "../errors";
import {
  CLI_VERSION,
  SYSTEM_ITEMS,
  findSystemItem,
  shaOfSystemItem,
} from "../bundled";
import {
  isCopyDirectoryItemKind,
  isCopyTargetFileItemKind,
  isFragmentItemKind,
  listMasterItems,
  ITEM_KINDS,
  parseItemKind,
  readPluginManifestName,
  shaOfGitVisibleItem,
  PLUGIN_MANIFEST_REL,
} from "../master";
import { sanitizeDisplayText } from "../pick-core";
import { shaOfCurrentSubagent } from "../subagents";
import type { ItemKind } from "../master";
import { entryIdentity, loadLocalLock, loadLock } from "../lock";
import { loadManifest } from "../manifest";
import { shortIdentity } from "../pin";
import { parseLockKey } from "../installed";
import { contentSourceOrNull, isBundled } from "../item-source";
import type { ContentSource } from "../item-source";
import {
  assertIsGitRepo,
  sourceVisibleFilesLister,
  type VisibleFilesLister,
} from "../git";
import { globalOpts } from "../global-options";
import { shaOfFragmentItem } from "../fragments";
import {
  loadDataItemMetadata,
  loadSystemItemMetadata,
  matchesTagFilter,
  metadataLineSuffix,
  printMetadataWarnings,
  emptyNeeds,
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

/** Shared default array; never mutate it. */
const NO_TAGS: string[] = [];

export function registerLs(program: Command): void {
  program
    .command("ls")
    .description(
      "list available items (data repo + system) or installed items with --here",
    )
    .option("--here", "list items installed in the current project")
    .option("--user", "list user-level runtime skills")
    .option("--json", "output JSON")
    .option("-k, --kind <kind>", `filter by kind (${ITEM_KINDS.join("|")})`)
    .option(
      "--tag <tag>",
      "filter by tag (repeatable; repeated tags narrow with AND)",
      (value: string, previous: string[]) => [...previous, value],
      NO_TAGS,
    )
    .action(async (opts: LsOptions, cmd: Command) => {
      const kindFilter = opts.kind ? parseItemKind(opts.kind) : undefined;

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
        // Works outside a project via --data or $CAPSHELF_HOME so a shelf can
        // be evaluated before adoption.
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

interface PluginNameWarning {
  path: string;
  message: string;
}

async function pluginNameWarnings(
  dataRepo: string,
): Promise<PluginNameWarning[]> {
  const dir = join(dataRepo, "plugins");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const warnings: PluginNameWarning[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = join(
      dir,
      entry.name,
      ...PLUGIN_MANIFEST_REL.split("/"),
    );
    const manifestName = await readPluginManifestName(manifestPath);
    if (manifestName === null || manifestName === entry.name) continue;
    const dirName = sanitizeDisplayText(entry.name);
    const safeManifestName = sanitizeDisplayText(manifestName);
    warnings.push({
      path: `plugins/${dirName}`,
      message:
        `is not listed: its plugin.json names it "${safeManifestName}". ` +
        `Rename the directory to plugins/${safeManifestName}.`,
    });
  }
  return warnings;
}

async function lsAvailable(
  project: string | null,
  dataRepo: string,
  kind: ItemKind | undefined,
  tags: string[],
  json: boolean,
): Promise<void> {
  // Errors propagate so bad bindings are not hidden as "no data items".
  await assertIsGitRepo(dataRepo);
  const dataItems = await listMasterItems(dataRepo, kind);
  const systemItems = SYSTEM_ITEMS.filter((s) => !kind || s.kind === kind);
  const pluginWarnings =
    !kind || kind === "plugins" ? await pluginNameWarnings(dataRepo) : [];

  // A skill and plugin of the same name can both be on the shelf but a project
  // uses only one; with --kind plugins the skill names are fetched separately.
  const skillNames = new Set(
    dataItems.filter((item) => item.kind === "skills").map((item) => item.name),
  );
  if (kind === "plugins") {
    for (const item of await listMasterItems(dataRepo, "skills")) {
      skillNames.add(item.name);
    }
  }
  const mode = project ? detectInstallMode(project) : DEFAULT_INSTALL_MODE;
  const skillTargetDir =
    mode === "claude-only" ? ".claude/skills" : ".agents/skills";
  const sharesTargetWith = (itemKind: ItemKind, name: string): string | null =>
    itemKind === "plugins" && skillNames.has(name) ? `skills/${name}` : null;

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
  const listFiles = await sourceVisibleFilesLister(
    dataRepo,
    dataRows
      .filter(({ item }) => isCopyDirectoryItemKind(item.kind))
      .map(({ item }) => item.repoRelPath),
  );
  for (const { meta } of [...systemRows, ...dataRows]) {
    printMetadataWarnings(meta);
  }

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
      dataRows.map(async ({ item, meta }) => {
        const shared = sharesTargetWith(item.kind, item.name);
        return {
          source: "data" as const,
          kind: item.kind,
          name: item.name,
          sha: await shaOfDataItem(dataRepo, item, listFiles),
          path: item.path,
          ...metadataJsonFields(meta),
          ...(shared && { sharesTargetWith: shared }),
        };
      }),
    );
    console.log(
      JSON.stringify(
        {
          dataRepo,
          system: sysRows,
          data: dataJsonRows,
          externalUserSkills,
          ...(pluginWarnings.length > 0 && { warnings: pluginWarnings }),
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
      const sha = await shaOfDataItem(dataRepo, item, listFiles);
      console.log(
        `  ${item.kind}/${item.name.padEnd(26)} ${sha}${metadataLineSuffix(meta)}`,
      );
      const shared = sharesTargetWith(item.kind, item.name);
      if (shared) {
        console.log(
          `    ^ ${shared} and ${item.kind}/${item.name} both install to ${skillTargetDir}/${item.name}. A project uses one of them.`,
        );
      }
    }
  }

  for (const warning of pluginWarnings) {
    console.error(`⚠ ${warning.path} ${warning.message}`);
  }

  if (bundleRows.length > 0) {
    console.log("");
    console.log(`bundles/  (from ${homeRelative(dataRepo)})`);
    for (const bundle of bundleRows) {
      const counts = bundle.malformed ? "" : memberCountSummary(bundle);
      const line = `  ${bundle.name.padEnd(33)}${counts ? ` ${counts}` : ""}${metadataLineSuffix(bundleMeta(bundle))}`;
      console.log(line.trimEnd());
    }
  }

  if (externalUserSkills.length > 0) {
    console.log("");
    console.log(formatUserSkillsHuman(externalUserSkills).join("\n"));
  }

  if (dataRows.length === 0 && bundleRows.length === 0) {
    console.log("");
    console.log("next:");
    console.log(
      "  capshelf share skills/<name> --to project  # adopt a skill this project already has",
    );
    console.log(
      "  capshelf share mcp/<name>                  # adopt a server from this project's .mcp.json",
    );
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

function bundleMeta(bundle: Bundle): ItemMetadata {
  return {
    ...(bundle.description !== undefined && {
      description: bundle.description,
    }),
    tags: bundle.tags,
    requires: [],
    conflictsWith: [],
    needs: emptyNeeds(),
    warnings: [],
  };
}

interface MetadataJsonFields {
  description?: string;
  tags?: string[];
}

function metadataJsonFields(meta: ItemMetadata): MetadataJsonFields {
  return {
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.tags.length > 0 && { tags: meta.tags }),
  };
}

async function shaOfDataItem(
  dataRepo: string,
  item: { kind: ItemKind; name: string; repoRelPath: string },
  listFiles?: VisibleFilesLister,
): Promise<string> {
  if (isFragmentItemKind(item.kind)) {
    return await shaOfFragmentItem(dataRepo, item.kind, item.name);
  }
  if (isCopyDirectoryItemKind(item.kind)) {
    return await shaOfGitVisibleItem(dataRepo, item.repoRelPath, listFiles);
  }
  if (isCopyTargetFileItemKind(item.kind)) {
    return await shaOfCurrentSubagent("", dataRepo, item.name);
  }
  throw new Error(`no listing strategy for ${item.kind}/${item.name}`);
}

/**
 * Best-effort: the sidecar is never materialized and an unbound clone or
 * missing upstream item must not break `ls --here`.
 */
async function installedRowMetadata(
  source: ContentSource | null,
  kind: ItemKind,
  name: string,
): Promise<ItemMetadata | null> {
  try {
    if (source === null) return null;
    if (isBundled(source)) {
      const item = findSystemItem(name);
      if (!item || item.kind !== kind) return null;
      return loadSystemItemMetadata(item);
    }
    // Reads the working tree, not the commit, because `ls --here` describes the
    // shelf as it is now.
    const path = join(source.repo, ...source.itemRoot.split("/"));
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

  // Use lockedSha: v4 data entries have no `sha`, only `sourcePinDigest`.
  const projectEntries = Object.entries(projectLock.items).map(
    ([key, entry]) => {
      const { kind: k, name } = parseLockKey(key);
      return {
        scope: "project" as const,
        kind: k,
        name,
        ...entry,
        lockedSha: entryIdentity(entry),
      };
    },
  );
  const localEntries = Object.entries(localLock.items).map(([key, entry]) => {
    const { kind: k, name } = parseLockKey(key);
    return {
      scope: "local" as const,
      kind: k,
      name,
      ...entry,
      lockedSha: entryIdentity(entry),
    };
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
      contentSourceOrNull({
        entry,
        kind: entry.kind,
        name: entry.name,
        repo: dataRepo,
      }),
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
        rows.map(({ entry, meta }) =>
          meta ? { ...entry, ...metadataJsonFields(meta) } : { ...entry },
        ),
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
        `  ${entry.kind}/${entry.name.padEnd(26)} ${shortIdentity(entry.lockedSha)}${meta ? metadataLineSuffix(meta) : ""}`,
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
        `  ${entry.kind}/${entry.name.padEnd(26)} ${shortIdentity(entry.lockedSha)}${label}${meta ? metadataLineSuffix(meta) : ""}`,
      );
    }
    printedSection = true;
  }
}
