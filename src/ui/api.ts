/**
 * What the web UI server answers with. Every function reads the same files
 * and runs the same Git queries as the CLI command it stands in for:
 * `status`, `status --diff`, `ls`, and `show`. It adds display fields and the
 * commands a state can be resolved with; it computes no new fact.
 */
import { hostname } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { CLI_VERSION, SYSTEM_ITEMS, findSystemItem } from "../bundled";
import { listBundles, memberRef } from "../bundles";
import { NotFoundError, PreconditionError } from "../errors";
import {
  currentBranch,
  headSha,
  isRepoClean,
  originRemoteUrl,
  sourceRead,
  sourceReadText,
  sourceVisibleFilesUnderPath,
} from "../git";
import { installedPath, parseLockKey } from "../installed";
import { findMasterItemByRef, parseItemRef } from "../item-ref";
import { entryIdentity, loadLocalLock, loadLock } from "../lock";
import type { Lock } from "../lock";
import { loadManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  canonicalItemRelPaths,
  isCopyDirectoryItemKind,
  isMetadataSidecarPath,
  listMasterItems,
} from "../master";
import type { ItemKind, MasterItem } from "../master";
import { loadDataItemMetadata, loadSystemItemMetadata } from "../metadata";
import type { ItemMetadata } from "../metadata";
import { homeRelative, manifestReadPath, shellArg } from "../paths";
import { currentSourceCommit } from "../pin";
import { loadProjectRegistry } from "../project-registry";
import {
  MAX_SEARCHABLE_CONTENT_BYTES,
  isSearchableContent,
} from "../search-core";
import { actionsForRow } from "../status-actions";
import { assertNoScopeCollisions } from "../status-core";
import type { StatusRow } from "../status-core";
import { buildStatusDiff } from "../status-diff";
import { describe } from "../status-format";
import {
  buildStatusReport,
  resolveStatusDataRepo,
  rowFailsStrict,
  statusDiffViews,
} from "../status-report";
import type {
  DiffViewName,
  UiAction,
  UiBundle,
  UiDiffResponse,
  UiItem,
  UiItemUsage,
  UiNotice,
  UiOverview,
  UiProjectStatus,
  UiRegisteredProject,
  UiRevision,
  UiShelf,
  UiShelfFacts,
  UiShelfFile,
  UiShelfItem,
  UiShelfItemDetail,
  UiShelfItemMetadata,
  UiShelfRef,
} from "./shared/api-types";
import { stateLabel, stateTone } from "./shared/state-label";

export interface UiContext {
  registryPath: string;
  /** The global `--data` override, applied to every project. */
  dataOverride?: string;
  /** The project the command ran inside, selected first in the UI. */
  currentProject?: string | null;
}

interface LoadedProject {
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  dataRepo: string | null;
  rows: StatusRow[];
}

const REVISION_COUNT = 30;
const REVISION_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%aI";

export interface UiApi {
  overview(): Promise<UiOverview>;
  projectStatus(path: string): Promise<UiProjectStatus>;
  projectDiff(
    path: string,
    itemId: string,
    view: DiffViewName,
  ): Promise<UiDiffResponse>;
  shelf(dataRepo: string): Promise<UiShelf>;
  shelfItem(
    dataRepo: string,
    ref: string,
    file: string | undefined,
  ): Promise<UiShelfItemDetail>;
}

export function itemId(
  row: Pick<StatusRow, "scope" | "source" | "kind" | "name">,
): string {
  return `${row.scope}/${row.source}/${row.kind}/${row.name}`;
}

export function createUiApi(ctx: UiContext): UiApi {
  // The rows a project last reported. A diff request names one of them, so
  // the comparison is built from the row the user is looking at rather than
  // from a second status run that could disagree with it.
  const loaded = new Map<string, LoadedProject>();

  async function registeredProjects(): Promise<UiRegisteredProject[]> {
    const registry = await loadProjectRegistry(ctx.registryPath);
    return registry.projects.map((entry) => ({
      path: entry.path,
      display: homeRelative(entry.path),
      exists: manifestReadPath(entry.path) !== null,
      registeredAt: entry.registeredAt,
    }));
  }

  async function requireRegistered(path: string): Promise<UiRegisteredProject> {
    const projects = await registeredProjects();
    const found = projects.find((entry) => entry.path === path);
    if (!found) {
      throw new NotFoundError(`project is not registered: ${path}`, {
        hint: `run capshelf ui inside the project, or add it to ${ctx.registryPath}`,
      });
    }
    if (!found.exists) {
      throw new PreconditionError(
        `registered path has no capshelf project: ${path}`,
        {
          hint: `remove the entry from ${ctx.registryPath} if the project moved`,
        },
      );
    }
    return found;
  }

  /** The data repo each existing registered project resolves to. */
  async function boundShelves(): Promise<
    Array<{ project: UiRegisteredProject; dataRepo: string | null }>
  > {
    const out: Array<{
      project: UiRegisteredProject;
      dataRepo: string | null;
    }> = [];
    for (const project of await registeredProjects()) {
      if (!project.exists) continue;
      let dataRepo: string | null = null;
      try {
        dataRepo = await resolveStatusDataRepo({
          override: ctx.dataOverride,
          manifest: await loadManifest(project.path),
          project: project.path,
        });
      } catch {
        dataRepo = null;
      }
      out.push({ project, dataRepo });
    }
    return out;
  }

  async function loadProject(path: string): Promise<LoadedProject> {
    const registered = await requireRegistered(path);
    const project = registered.path;
    const manifest = await loadManifest(project);
    const [projectLock, localLock] = await Promise.all([
      loadLock(project),
      loadLocalLock(project),
    ]);
    assertNoScopeCollisions(projectLock, localLock);
    const dataRepo = await resolveStatusDataRepo({
      override: ctx.dataOverride,
      manifest,
      project,
    });
    const report = await buildStatusReport({
      project,
      manifest,
      projectLock,
      localLock,
      dataRepo,
    });
    const result: LoadedProject = {
      project,
      manifest,
      projectLock,
      localLock,
      dataRepo,
      rows: report.rows,
    };
    loaded.set(project, result);
    return result;
  }

  return {
    async overview(): Promise<UiOverview> {
      const projects = await registeredProjects();
      const shelves = new Map<string, UiShelfRef>();
      for (const bound of await boundShelves()) {
        if (bound.dataRepo === null || shelves.has(bound.dataRepo)) continue;
        shelves.set(bound.dataRepo, {
          dataRepo: bound.dataRepo,
          display: homeRelative(bound.dataRepo),
        });
      }
      return {
        host: hostname(),
        cliVersion: CLI_VERSION,
        currentProject: ctx.currentProject ?? null,
        registryPath: ctx.registryPath,
        registryDisplay: homeRelative(ctx.registryPath),
        dataOverride: ctx.dataOverride ?? null,
        projects,
        shelves: [...shelves.values()],
        generatedAt: new Date().toISOString(),
      };
    },

    async projectStatus(path: string): Promise<UiProjectStatus> {
      const registered = await requireRegistered(path);
      const project = registered.path;
      const manifest = await loadManifest(project);
      const [projectLock, localLock] = await Promise.all([
        loadLock(project),
        loadLocalLock(project),
      ]);
      assertNoScopeCollisions(projectLock, localLock);
      const dataRepo = await resolveStatusDataRepo({
        override: ctx.dataOverride,
        manifest,
        project,
      });
      const report = await buildStatusReport({
        project,
        manifest,
        projectLock,
        localLock,
        dataRepo,
      });
      loaded.set(project, {
        project,
        manifest,
        projectLock,
        localLock,
        dataRepo,
        rows: report.rows,
      });

      const notices: UiNotice[] = [];
      if (dataRepo === null) {
        notices.push(noDataRepoNotice(manifest));
      }
      if (projectLock.version < 4 || localLock.version < 4) {
        notices.push(legacyLockNotice(projectLock.version, localLock.version));
      }

      return {
        project,
        display: registered.display,
        cdCommand: `cd ${shellArg(project)}`,
        dataRepo,
        dataRepoDisplay: dataRepo === null ? null : homeRelative(dataRepo),
        dataRepoUpstream: manifest.dataRepoUpstream ?? null,
        lockVersion: projectLock.version,
        localLockVersion: localLock.version,
        installMode: manifest.installMode,
        cliVersion: CLI_VERSION,
        items: report.rows.map((row) =>
          toUiItem(row, project, dataRepo, ctx.dataOverride),
        ),
        external: report.external,
        externalClaudePlugins: report.externalClaudePlugins,
        externalUserSkills: report.externalUserSkills,
        personalClaudeExternal: report.personalClaudeExternal,
        shelf: dataRepo === null ? null : await shelfFacts(dataRepo),
        notices,
        generatedAt: new Date().toISOString(),
      };
    },

    async projectDiff(
      path: string,
      id: string,
      view: DiffViewName,
    ): Promise<UiDiffResponse> {
      const state = loaded.get(path) ?? (await loadProject(path));
      const row = state.rows.find((candidate) => itemId(candidate) === id);
      if (!row) {
        throw new NotFoundError(`item is not tracked in this project: ${id}`);
      }
      if (!statusDiffViews(row.state).includes(view)) {
        return { item: id, view, diff: null };
      }
      const diff = await buildStatusDiff({
        project: state.project,
        dataRepo: state.dataRepo,
        manifest: state.manifest,
        lock: row.scope === "local" ? state.localLock : state.projectLock,
        row,
        view,
      });
      return { item: id, view, diff };
    },

    async shelf(dataRepo: string): Promise<UiShelf> {
      const bound = await boundShelves();
      const projects = bound
        .filter((entry) => entry.dataRepo === dataRepo)
        .map((entry) => entry.project);
      if (projects.length === 0) {
        throw new NotFoundError(
          `no registered project is bound to ${dataRepo}`,
        );
      }
      const warnings: string[] = [];
      const usage = await usageByRef(projects);

      const masterItems = await listMasterItems(dataRepo);
      const commits = new Map<string, string | null>();
      const items: UiShelfItem[] = [];
      for (const item of masterItems) {
        const meta = await loadDataItemMetadata(item);
        warnings.push(...meta.warnings);
        const commit = await sourceCommitOrNull(dataRepo, item.kind, item.name);
        commits.set(`${item.kind}/${item.name}`, commit);
        items.push({
          ref: `${item.kind}/${item.name}`,
          kind: item.kind,
          name: item.name,
          source: "data",
          ...(meta.description !== undefined && {
            description: meta.description,
          }),
          tags: meta.tags,
          lastCommit: null,
          usage: [],
        });
      }
      const revisions = await revisionDetails(
        dataRepo,
        [...commits.values()].filter((sha): sha is string => sha !== null),
      );
      for (const item of items) {
        const sha = commits.get(item.ref) ?? null;
        item.lastCommit = sha === null ? null : (revisions.get(sha) ?? null);
        item.usage = (usage.get(item.ref) ?? []).map((entry) => ({
          ...entry,
          current:
            sha === null || entry.sourceCommit === null
              ? null
              : entry.sourceCommit === sha,
        }));
      }
      for (const system of SYSTEM_ITEMS) {
        const meta = loadSystemItemMetadata(system);
        warnings.push(...meta.warnings);
        const ref = `${system.kind}/${system.name}`;
        items.push({
          ref,
          kind: system.kind,
          name: system.name,
          source: "system",
          ...(meta.description !== undefined && {
            description: meta.description,
          }),
          tags: meta.tags,
          lastCommit: null,
          usage: usage.get(`system:${ref}`) ?? [],
        });
      }

      const listing = await listBundles(dataRepo);
      warnings.push(...listing.warnings);
      const bundles: UiBundle[] = listing.bundles.map((bundle) => {
        warnings.push(...bundle.warnings);
        return {
          ref: `bundles/${bundle.name}`,
          name: bundle.name,
          ...(bundle.description !== undefined && {
            description: bundle.description,
          }),
          tags: bundle.tags,
          members: bundle.members.map(memberRef),
          ...(bundle.malformed !== undefined && {
            malformed: bundle.malformed,
          }),
        };
      });

      return {
        dataRepo,
        display: homeRelative(dataRepo),
        facts: await shelfFacts(dataRepo),
        items,
        bundles,
        warnings: [...new Set(warnings)],
        projects,
        generatedAt: new Date().toISOString(),
      };
    },

    async shelfItem(
      dataRepo: string,
      refText: string,
      file: string | undefined,
    ): Promise<UiShelfItemDetail> {
      const bound = await boundShelves();
      const projects = bound
        .filter((entry) => entry.dataRepo === dataRepo)
        .map((entry) => entry.project);
      if (projects.length === 0) {
        throw new NotFoundError(
          `no registered project is bound to ${dataRepo}`,
        );
      }
      const ref = parseItemRef(refText);
      const usage = await usageByRef(projects);

      const system = findSystemItem(ref.name);
      if (system && (ref.kind === undefined || system.kind === ref.kind)) {
        const meta = loadSystemItemMetadata(system);
        const files = system.files.map((entry) => entry.relPath).sort();
        const name = file ?? primaryFile(system.kind, files);
        const bundled = system.files.find((entry) => entry.relPath === name);
        if (file !== undefined && !bundled) {
          throw new NotFoundError(
            `no file ${file} in ${system.kind}/${system.name}`,
          );
        }
        const key = `${system.kind}/${system.name}`;
        return {
          ref: key,
          kind: system.kind,
          name: system.name,
          source: "system",
          ...(meta.description !== undefined && {
            description: meta.description,
          }),
          tags: meta.tags,
          lastCommit: null,
          usage: usage.get(`system:${key}`) ?? [],
          path: null,
          metadata: metadataFields(meta),
          files,
          file: bundled
            ? {
                name: bundled.relPath,
                text: bundled.content,
                binary: false,
                size: Buffer.byteLength(bundled.content, "utf-8"),
              }
            : null,
        };
      }

      const item = await findMasterItemByRef(dataRepo, ref);
      if (!item) throw new NotFoundError(`not found: ${refText}`);
      const meta = await loadDataItemMetadata(item);
      const files = await itemFiles(dataRepo, item);
      const name = file ?? primaryFile(item.kind, files);
      if (file !== undefined && !files.includes(file)) {
        throw new NotFoundError(`no file ${file} in ${item.kind}/${item.name}`);
      }
      const sha = await sourceCommitOrNull(dataRepo, item.kind, item.name);
      const revisions =
        sha === null
          ? new Map<string, UiRevision>()
          : await revisionDetails(dataRepo, [sha]);
      const key = `${item.kind}/${item.name}`;
      return {
        ref: key,
        kind: item.kind,
        name: item.name,
        source: "data",
        ...(meta.description !== undefined && {
          description: meta.description,
        }),
        tags: meta.tags,
        lastCommit: sha === null ? null : (revisions.get(sha) ?? null),
        usage: (usage.get(key) ?? []).map((entry) => ({
          ...entry,
          current:
            sha === null || entry.sourceCommit === null
              ? null
              : entry.sourceCommit === sha,
        })),
        path: item.path,
        metadata: metadataFields(meta),
        files,
        file: name === null ? null : await readItemFile(item, name),
      };
    },
  };

  async function usageByRef(
    projects: UiRegisteredProject[],
  ): Promise<Map<string, UiItemUsage[]>> {
    const usage = new Map<string, UiItemUsage[]>();
    for (const project of projects) {
      const locks: Array<{ scope: "project" | "local"; lock: Lock }> = [
        { scope: "project", lock: await loadLock(project.path) },
        { scope: "local", lock: await loadLocalLock(project.path) },
      ];
      for (const { scope, lock } of locks) {
        for (const [key, entry] of Object.entries(lock.items)) {
          const parsed = parseLockKey(key);
          const ref = `${parsed.kind}/${parsed.name}`;
          const usageKey = parsed.source === "system" ? `system:${ref}` : ref;
          const list = usage.get(usageKey) ?? [];
          list.push({
            project: project.path,
            display: project.display,
            scope,
            sourceCommit: entry.source === "data" ? entry.sourceCommit : null,
            sourceCommitShort:
              entry.source === "data" ? entry.sourceCommit.slice(0, 7) : null,
            cliVersion: entry.source === "system" ? entry.cliVersion : null,
            lockedSha: entryIdentity(entry),
            current: null,
            keptLocal: entry.source === "data" && entry.local === true,
          });
          usage.set(usageKey, list);
        }
      }
    }
    return usage;
  }
}

function toUiItem(
  row: StatusRow,
  project: string,
  dataRepo: string | null,
  dataOverride: string | undefined,
): UiItem {
  let installed: string | null = null;
  try {
    installed = relative(project, installedPath(project, row.kind, row.name));
  } catch {
    // A subagent owns two output targets; `row.targets` names them.
    installed = null;
  }
  return {
    id: itemId(row),
    ref: `${row.kind}/${row.name}`,
    kind: row.kind,
    name: row.name,
    scope: row.scope,
    source: row.source,
    row,
    attention: rowFailsStrict(row),
    tone: stateTone(row.state),
    stateLabel: stateLabel(row.state, row.source),
    stateDetail: describe(row),
    actions: actionsForRow(row, { dataOverride, dataRepo }),
    diffViews: statusDiffViews(row.state),
    installedPath: installed,
  };
}

function noDataRepoNotice(manifest: Manifest): UiNotice {
  const actions: UiAction[] = [];
  if (manifest.dataRepoUpstream) {
    actions.push({
      command: "capshelf init",
      purpose: `Clone ${manifest.dataRepoUpstream} and bind this project to the clone.`,
    });
  }
  return {
    level: "warn",
    message: manifest.dataRepoUpstream
      ? "No data repo is bound on this machine, so every data item reads as gone from the shelf. Bind an existing clone with capshelf data bind <path>."
      : "No data repo is bound on this machine, so every data item reads as gone from the shelf. Bind a clone with capshelf data bind <path>, or set CAPSHELF_HOME.",
    ...(actions.length > 0 && { actions }),
  };
}

function legacyLockNotice(
  projectVersion: number,
  localVersion: number,
): UiNotice {
  const versions = [
    `project lock version ${projectVersion}`,
    ...(localVersion < 4 ? [`local lock version ${localVersion}`] : []),
  ];
  return {
    level: "warn",
    message: `This project has a legacy lock (${versions.join(", ")}). Commands that write the lock refuse until it is migrated.`,
    actions: [
      {
        command: "capshelf lock migrate --dry-run",
        purpose: "Preview the migration to lock version 4.",
      },
      {
        command: "capshelf lock migrate",
        purpose: "Convert both locks to version 4 in one transaction.",
      },
    ],
  };
}

async function shelfFacts(dataRepo: string): Promise<UiShelfFacts> {
  let head = "";
  try {
    head = await headSha(dataRepo);
  } catch {
    head = "";
  }
  return {
    dataRepo,
    display: homeRelative(dataRepo),
    head,
    headShort: head.slice(0, 7),
    branch: await currentBranch(dataRepo),
    origin: (await originRemoteUrl(dataRepo))?.trim() ?? null,
    clean: await isRepoClean(dataRepo),
    revisions: head === "" ? [] : await recentRevisions(dataRepo),
  };
}

async function recentRevisions(dataRepo: string): Promise<UiRevision[]> {
  const result = await sourceRead(dataRepo, [
    "log",
    `-n${REVISION_COUNT}`,
    `--format=${REVISION_FORMAT}`,
  ]);
  if (result.exitCode !== 0) return [];
  return parseRevisions(result.stdout.toString("utf-8"));
}

/** Details for a set of commits, one `git show` for all of them. */
async function revisionDetails(
  dataRepo: string,
  shas: string[],
): Promise<Map<string, UiRevision>> {
  const unique = [...new Set(shas)];
  if (unique.length === 0) return new Map();
  const out = await sourceReadText(dataRepo, [
    "show",
    "-s",
    `--format=${REVISION_FORMAT}`,
    ...unique,
  ]);
  return new Map(parseRevisions(out).map((rev) => [rev.sha, rev]));
}

function parseRevisions(text: string): UiRevision[] {
  const out: UiRevision[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const [sha, short, subject, author, date] = line.split("\x1f");
    if (!sha || !short) continue;
    out.push({
      sha,
      short,
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
    });
  }
  return out;
}

async function sourceCommitOrNull(
  dataRepo: string,
  kind: ItemKind,
  name: string,
): Promise<string | null> {
  try {
    return await currentSourceCommit(dataRepo, kind, name);
  } catch {
    return null;
  }
}

function metadataFields(meta: ItemMetadata): UiShelfItemMetadata {
  return {
    ...(meta.description !== undefined && { description: meta.description }),
    tags: meta.tags,
    requires: meta.requires,
    conflictsWith: meta.conflictsWith,
    needs: meta.needs,
    warnings: meta.warnings,
  };
}

async function itemFiles(
  dataRepo: string,
  item: MasterItem,
): Promise<string[]> {
  if (isCopyDirectoryItemKind(item.kind)) {
    return (await sourceVisibleFilesUnderPath(dataRepo, item.repoRelPath))
      .filter((rel) => !isMetadataSidecarPath(rel))
      .sort();
  }
  return (await canonicalItemRelPaths(dataRepo, item.kind, item.name))
    .map((rel) => posix.relative(item.repoRelPath, rel))
    .sort();
}

function primaryFile(kind: ItemKind, files: string[]): string | null {
  const preferred =
    kind === "skills"
      ? "SKILL.md"
      : kind === "pi-extensions"
        ? "index.ts"
        : null;
  if (preferred !== null && files.includes(preferred)) return preferred;
  return files[0] ?? null;
}

async function readItemFile(
  item: MasterItem,
  name: string,
): Promise<UiShelfFile> {
  const path = join(item.path, ...name.split("/"));
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SEARCHABLE_CONTENT_BYTES) {
    return { name, text: null, binary: false, size: info.size };
  }
  const bytes = await readFile(path);
  if (!isSearchableContent(name, bytes)) {
    return { name, text: null, binary: true, size: info.size };
  }
  return {
    name,
    text: bytes.toString("utf-8"),
    binary: false,
    size: info.size,
  };
}
