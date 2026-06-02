import type { Command } from "commander";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { readFile, readdir, rm as fsRm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import { addManifestName, removeManifestName } from "../manifest";
import {
  dataKey,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { DataLockEntry, Lock } from "../lock";
import {
  claudeSkillPath,
  codexSkillPath,
  ensureInstallAliases,
  installedPath,
  parseLockKey,
  shaOfInstalled,
} from "../installed";
import { shaOfGitVisibleItem, shaOfItem } from "../master";
import type { ItemKind } from "../master";
import { CheckFailedError, NotFoundError, PreconditionError } from "../errors";
import {
  assertIsGitRepo,
  assertRepoClean,
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitInRepo,
  gitVisibleFilesUnderPath,
  lastTouchingCommit,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { globalOpts } from "../cli";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import {
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
} from "../local-config";
import type { LocalConfig } from "../local-config";
import { replaceDirFromDir, replaceDirFromGitVisibleFiles } from "../sync";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import type { RuntimeWarning } from "../runtime-warnings";
import { isIgnoredDotDirent, privateDotenvFiles } from "../dotfiles";
import {
  allCanonicalFragmentRelPaths,
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  isFragmentKind,
  parseFragmentSourceText,
  shaOfFragmentItem,
  touchedFragmentTargetsForItem,
} from "../fragments";

interface PromoteOptions {
  create?: boolean;
  message?: string;
  json?: boolean;
  local?: boolean;
}

export interface PromoteResult {
  source: "data";
  kind: ItemKind;
  name: string;
  action: "promoted" | "created" | "already-current";
  sha: string;
  sourceCommit: string;
  committed: boolean;
  runtimeWarnings?: RuntimeWarning[];
  privateDotenvWarnings?: string[];
}

export type Scope = "project" | "local";

interface AdoptionSource {
  path: string;
  kind: "installed" | "claude-real";
}

interface AdoptOptions {
  installMode: Manifest["installMode"];
  message?: string;
  sourceScope?: Scope;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
}

export interface MoveScopeState {
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  localConfig: LocalConfig | null;
}

export interface MoveScopeResult {
  kind: ItemKind;
  name: string;
  from: Scope;
  to: Scope;
  sha: string;
  sourceCommit: string;
  alreadyCurrent?: true;
}

export function registerPromote(program: Command): void {
  program
    .command("promote <item>")
    .description(
      "push edits for an already-tracked data item into the data repo and bump the lock",
    )
    .option("--create", "deprecated: use share <item> --to project")
    .option("--local", "promote a local-scope item")
    .option("-m, --message <msg>", "git commit message")
    .option("--json", "output JSON")
    .action(async (itemRef: string, opts: PromoteOptions, cmd: Command) => {
      const ref = parseItemRef(itemRef);
      if (isSystemItemName(ref.name)) {
        throw new PreconditionError(
          `"${ref.name}" is a system item — submit a PR to the capshelf repo instead`,
        );
      }

      const project = projectRoot();
      const manifest = await loadManifest(project);
      const lock = await loadLock(project);
      const localLock = await loadLocalLock(project);
      const dataRepo = await resolveDataRepo({
        override: globalOpts(cmd).data,
        manifest,
        project,
      });
      await assertIsGitRepo(dataRepo);

      printDeprecationHint(itemRef, opts);

      let result: PromoteResult;
      let saveProject = false;
      let saveLocal = false;
      if (opts.create) {
        if (opts.local) {
          throw new PreconditionError(
            `promote ${itemRef} --local --create is no longer supported; use: capshelf share ${itemRef}`,
          );
        }
        result = await promoteCreate(
          project,
          dataRepo,
          manifest,
          lock,
          ref,
          opts,
        );
        saveProject = true;
      } else if (opts.local) {
        result = await promoteLocalTracked(
          project,
          dataRepo,
          localLock,
          ref,
          opts,
        );
        saveLocal = true;
      } else {
        result = await promoteProjectTracked(
          project,
          dataRepo,
          manifest,
          lock,
          localLock,
          ref,
          opts,
        );
        saveProject = true;
      }

      if (saveProject) {
        await saveManifest(project, manifest);
        await saveLock(project, lock);
      }
      if (saveLocal) {
        await saveLocalLock(project, localLock);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `✓ ${result.action} data/${result.kind}/${result.name} @ ${result.sha}`,
      );
      console.log(`  source commit: ${result.sourceCommit}`);
      printRuntimeWarnings(result.runtimeWarnings);
      printPrivateDotenvWarnings(result.privateDotenvWarnings);
    });
}

function printDeprecationHint(itemRef: string, opts: PromoteOptions): void {
  if (opts.create) {
    console.error(
      `⚠ promote --create is deprecated; use: capshelf share ${itemRef} --to project`,
    );
  }
}

async function promoteProjectTracked(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  projectLock: Lock,
  localLock: Lock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(projectLock, ref, "data");
  if (!key) {
    const localKey = lockKeyForRef(localLock, ref, "data");
    if (localKey) {
      const parsed = parseLockKey(localKey);
      const display = `${parsed.kind}/${parsed.name}`;
      throw new NotFoundError(
        `not tracked in project scope: ${display}\n` +
          `  found in local scope; run: capshelf promote ${display} --local`,
      );
    }
    return await rejectUntrackedPromote(project, projectLock, ref);
  }

  const parsed = parseLockKey(key);
  if (isFragmentKind(parsed.kind)) {
    const result = await promoteFragmentSource(
      project,
      dataRepo,
      manifest,
      projectLock,
      parsed.kind,
      parsed.name,
      opts,
    );
    addToManifest(manifest, parsed.kind, parsed.name);
    return result;
  }

  const result = await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    projectLock,
    opts,
  );
  addToManifest(manifest, parsed.kind, parsed.name);
  return result;
}

async function promoteLocalTracked(
  project: string,
  dataRepo: string,
  localLock: Lock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = lockKeyForRef(localLock, ref, "data");
  if (!key) {
    if (ref.kind === undefined || ref.kind === "skills") {
      const external = await findSkillsShSkill(project, ref.name);
      if (external) {
        throw new PreconditionError(
          `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
        );
      }
    }
    throw new NotFoundError(`not tracked in local scope: ${refDisplay(ref)}`);
  }

  const parsed = parseLockKey(key);
  assertLocalScopeSupported(parsed.kind, parsed.name, "promote");
  return await syncTrackedIntoDataRepo(
    project,
    dataRepo,
    parsed.kind,
    parsed.name,
    localLock,
    { ...opts, scope: "local" },
  );
}

async function rejectUntrackedPromote(
  project: string,
  lock: Lock,
  ref: ReturnType<typeof parseItemRef>,
): Promise<never> {
  if (ref.kind === undefined || ref.kind === "skills") {
    const external = await findSkillsShSkill(project, ref.name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${ref.name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }
  const systemKey = lockKeyForRef(lock, ref, "system");
  if (systemKey) {
    throw new PreconditionError(
      `${ref.name} is a system item — submit a PR to the capshelf repo instead`,
    );
  }
  const display = refDisplay(ref);
  const adoptHint =
    ref.kind === undefined || ref.kind === "skills"
      ? `\n  to adopt a local-only skill into the data repo, run: capshelf share ${display} --to project`
      : "";
  throw new NotFoundError(
    `not tracked in this project: ${display}${adoptHint}`,
  );
}

async function promoteFragmentSource(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  kind: Exclude<ItemKind, "skills">,
  name: string,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);
  const canonicalPaths = allCanonicalFragmentRelPaths(kind, name);
  const existingSources = await currentFragmentSourcesForItem(
    dataRepo,
    kind,
    name,
  ).catch(() => []);
  if (existingSources.length === 0) {
    throw new PreconditionError(
      `data repo does not have canonical source files for ${kind}/${name}`,
    );
  }

  await assertRepoCleanOutsidePaths(dataRepo, canonicalPaths);
  let dirty = false;
  const commitPaths: string[] = [];
  for (const relPath of canonicalPaths) {
    const pathDirty =
      (await statusPorcelain(dataRepo, relPath)).trim().length > 0;
    if (pathDirty || existsSync(join(dataRepo, ...relPath.split("/")))) {
      commitPaths.push(relPath);
    }
    dirty = dirty || pathDirty;
  }
  const currentSha = await shaOfFragmentItem(dataRepo, kind, name);
  if (!dirty) {
    if (currentSha === entry.sha) {
      return {
        source: "data",
        kind,
        name,
        action: "already-current",
        sha: currentSha,
        sourceCommit: entry.sourceCommit,
        committed: false,
      };
    }
    throw new PreconditionError(
      `${kind}/${name} has committed source changes not in this project lock; run capshelf update ${kind}/${name}`,
    );
  }

  for (const source of existingSources) {
    parseFragmentSourceText(
      source,
      await readFile(join(dataRepo, ...source.relPath.split("/")), "utf-8"),
    );
  }

  const oldLock = cloneJson(lock);
  const sourceCommit = await commitInRepo(
    dataRepo,
    commitPaths,
    opts.message ?? `capshelf: ${kind}/${name}`,
  );
  const sha = await shaOfFragmentItem(dataRepo, kind, name);
  const nextEntry = {
    source: "data" as const,
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
    ...(entry.label !== undefined && { label: entry.label }),
  };
  lock.items[key] = nextEntry;

  for (const target of await touchedFragmentTargetsForItem(
    dataRepo,
    kind,
    name,
    entry,
    manifest,
  )) {
    await applyFragmentOutput({
      project,
      dataRepo,
      manifest,
      oldLock,
      nextLock: lock,
      target,
    });
  }

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: true,
  };
}

export async function syncTrackedIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  lock: Lock,
  opts: SyncOptions,
): Promise<PromoteResult> {
  const key = dataKey(kind, name);
  const entry = dataEntryOrThrow(lock.items[key], key);

  if (isFragmentKind(kind)) {
    throw new PreconditionError(
      `promote for ${kind}/${name} must use project-scope fragment source files`,
    );
  }

  if (kind === "skills") {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not promoting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const repoRelPath = `${kind}/${name}`;
  if (!existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo does not have ${repoRelPath}; run "capshelf share ${kind}/${name}" instead`,
    );
  }

  const snapshot = await installedSnapshot(
    project,
    kind,
    name,
    opts.scope ?? "project",
  );
  if (!snapshot) {
    throw new Error(
      `installed files are missing: ${installedPath(project, kind, name)}`,
    );
  }
  const { localPath, sha } = snapshot;
  if (sha === entry.sha) {
    const runtimeWarnings = runtimeWarningsForItem(project, kind, name);
    return {
      source: "data",
      kind,
      name,
      action: "already-current",
      sha,
      sourceCommit: entry.sourceCommit,
      committed: false,
      ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    };
  }

  await assertRepoCleanOutsidePath(dataRepo, repoRelPath);
  const localRelPath = relative(project, localPath);
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  if (snapshot.source === "filesystem") {
    await replaceDirFromDir(localPath, join(dataRepo, repoRelPath));
  } else {
    await replaceDirFromGitVisibleFiles(
      project,
      localRelPath,
      localPath,
      join(dataRepo, repoRelPath),
    );
  }

  const dirty =
    (await statusPorcelain(dataRepo, repoRelPath)).trim().length > 0;
  const sourceCommit = dirty
    ? await commitInRepo(
        dataRepo,
        [repoRelPath],
        opts.message ?? `capshelf: ${kind}/${name}`,
      )
    : await lastTouchingCommit(dataRepo, repoRelPath);

  lock.items[key] = {
    source: "data",
    sha,
    sourceCommit,
    appliedAt: new Date().toISOString(),
    ...(entry.label !== undefined && { label: entry.label }),
  };
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "promoted",
    sha,
    sourceCommit,
    committed: dirty,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

async function promoteCreate(
  project: string,
  dataRepo: string,
  manifest: Manifest,
  lock: Lock,
  ref: ReturnType<typeof parseItemRef>,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  const kind = ref.kind ?? "skills";
  if (kind !== "skills") {
    throw new PreconditionError(
      "promote --create can only adopt local skills; use capshelf share for new mcp items",
    );
  }
  if (lockKeyForRef(lock, { kind, name: ref.name })) {
    throw new PreconditionError(
      `already tracked in this project: ${kind}/${ref.name}`,
    );
  }

  const adopted = await adoptIntoDataRepo(project, dataRepo, kind, ref.name, {
    installMode: manifest.installMode,
    message: opts.message,
  });

  addToManifest(manifest, kind, ref.name);
  lock.items[dataKey(kind, ref.name)] = {
    source: "data",
    sha: adopted.sha,
    sourceCommit: adopted.sourceCommit,
    appliedAt: new Date().toISOString(),
  };

  return adopted;
}

export async function adoptIntoDataRepo(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  opts: AdoptOptions,
): Promise<PromoteResult> {
  if (isFragmentKind(kind)) {
    throw new PreconditionError(
      `share for ${kind}/${name} requires --from <path> --to project`,
    );
  }
  if (kind === "skills") {
    const external = await findSkillsShSkill(project, name);
    if (external) {
      throw new PreconditionError(
        `not adopting skills/${name} — ${skillsShConflictMessage(external)}`,
      );
    }
  }

  const adoption = findAdoptionSource(project, kind, name, opts.installMode);
  if (!adoption) {
    throw new NotFoundError(
      `local item does not exist: ${expectedAdoptionPath(project, kind, name, opts.installMode)}`,
    );
  }

  const repoRelPath = `${kind}/${name}`;
  const dataPath = join(dataRepo, repoRelPath);
  if (existsSync(dataPath)) {
    throw new PreconditionError(
      `data repo item already exists: ${repoRelPath}`,
    );
  }

  if (kind === "skills") {
    assertCanNormalizeAdoptedSkill(project, name, adoption, opts.installMode);
  }
  await assertRepoClean(dataRepo);
  const adoptionRelPath = relative(project, adoption.path);
  const snapshot = await adoptionSnapshot(
    project,
    adoption.path,
    adoptionRelPath,
    opts.sourceScope ?? "project",
  );
  const privateDotenvWarnings = privateDotenvFiles(snapshot.files);
  if (snapshot.source === "filesystem") {
    await replaceDirFromDir(adoption.path, dataPath);
  } else {
    await replaceDirFromGitVisibleFiles(
      project,
      adoptionRelPath,
      adoption.path,
      dataPath,
    );
  }
  const sourceCommit = await commitInRepo(
    dataRepo,
    [repoRelPath],
    opts.message ?? `capshelf: ${kind}/${name}`,
  );

  if (kind === "skills") {
    await normalizeAdoptedSkill(project, name, adoption, opts.installMode);
  }
  const runtimeWarnings = runtimeWarningsForItem(project, kind, name);

  return {
    source: "data",
    kind,
    name,
    action: "created",
    sha: snapshot.sha,
    sourceCommit,
    committed: true,
    ...(runtimeWarnings.length > 0 && { runtimeWarnings }),
    ...(privateDotenvWarnings.length > 0 && { privateDotenvWarnings }),
  };
}

export async function moveScope(
  project: string,
  dataRepo: string,
  kind: ItemKind,
  name: string,
  to: Scope,
  state: MoveScopeState,
): Promise<MoveScopeResult> {
  const key = dataKey(kind, name);
  const projectEntry = state.projectLock.items[key];
  const localEntry = state.localLock.items[key];
  if (isFragmentKind(kind) && (to === "local" || localEntry !== undefined)) {
    assertLocalScopeSupported(kind, name, "move");
  }
  if (to === "local") {
    assertLocalScopeSupported(kind, name, "move");
  }
  if (!projectEntry && !localEntry) {
    throw new NotFoundError(`not tracked in this project: ${kind}/${name}`);
  }

  let from: Scope;
  let sourceEntry: DataLockEntry;
  if (projectEntry && localEntry) {
    const projectData = dataEntryOrThrow(projectEntry, key);
    const localData = dataEntryOrThrow(localEntry, key);
    if (!dataEntriesMatch(projectData, localData)) {
      throw new PreconditionError(
        `${kind}/${name} is owned by both project and local scope with different lock entries; remove one owner manually`,
      );
    }
    from = to === "project" ? "local" : "project";
    sourceEntry = from === "project" ? projectData : localData;
  } else {
    from = projectEntry ? "project" : "local";
    if (from === to) {
      const entry = dataEntryOrThrow(projectEntry ?? localEntry, key);
      return {
        kind,
        name,
        from,
        to,
        sha: entry.sha,
        sourceCommit: entry.sourceCommit,
        alreadyCurrent: true,
      };
    }
    sourceEntry = dataEntryOrThrow(
      from === "project" ? projectEntry : localEntry,
      key,
    );
  }

  const repoRelPath = `${kind}/${name}`;
  if (!existsSync(join(dataRepo, repoRelPath))) {
    throw new PreconditionError(
      `data repo does not have ${repoRelPath}; run "capshelf share ${kind}/${name} --to ${to}" instead`,
    );
  }

  const currentSnapshot = await installedSnapshot(
    project,
    kind,
    name,
    localEntry ? "local" : from,
  );
  const currentSha = currentSnapshot?.sha ?? null;
  if (currentSha !== sourceEntry.sha) {
    throw new CheckFailedError(
      `${kind}/${name} has uncommitted local edits; run "capshelf promote" or "capshelf revert" first`,
    );
  }

  if (to === "local") {
    if (!state.localConfig) {
      throw new Error(
        "no local manifest exists; run capshelf init or capshelf set-data first",
      );
    }
    await assertLocalInstallPathsUntracked(project, name);
  }

  const nextEntry = { ...sourceEntry };
  if (to === "project") {
    state.projectLock.items[key] = nextEntry;
    addToManifest(state.manifest, kind, name);
  } else {
    if (!state.localConfig) {
      throw new Error(
        "no local manifest exists; run capshelf init or capshelf set-data first",
      );
    }
    state.localLock.items[key] = nextEntry;
    if (!state.localConfig.skills.includes(name))
      state.localConfig.skills.push(name);
  }

  if (from === "project") {
    delete state.projectLock.items[key];
    removeFromManifest(state.manifest, kind, name);
  } else {
    delete state.localLock.items[key];
    if (state.localConfig) {
      state.localConfig.skills = state.localConfig.skills.filter(
        (x) => x !== name,
      );
    }
  }

  return {
    kind,
    name,
    from,
    to,
    sha: sourceEntry.sha,
    sourceCommit: sourceEntry.sourceCommit,
  };
}

export function printPrivateDotenvWarnings(files: string[] = []): void {
  if (files.length === 0) return;
  console.log("⚠ private-looking dotenv file promoted");
  for (const file of files) {
    console.log(`  ${file}`);
  }
  console.log(
    "  Tracked git content is promotable, but review these paths for secrets.",
  );
}

interface ItemSnapshot {
  source: "git-visible" | "filesystem";
  localPath: string;
  sha: string;
  files: string[];
}

async function installedSnapshot(
  project: string,
  kind: ItemKind,
  name: string,
  scope: Scope,
): Promise<ItemSnapshot | null> {
  const localPath = installedPath(project, kind, name);
  if (!existsSync(localPath)) return null;
  if (scope === "local") {
    return {
      source: "filesystem",
      localPath,
      sha: await shaOfItem(localPath),
      files: await itemFiles(localPath),
    };
  }
  const relPath = relative(project, localPath);
  return {
    source: "git-visible",
    localPath,
    sha:
      (await shaOfInstalled(project, kind, name)) ??
      (await shaOfItem(localPath)),
    files: await gitVisibleFilesUnderPath(project, relPath),
  };
}

async function adoptionSnapshot(
  project: string,
  path: string,
  relPath: string,
  scope: Scope,
): Promise<ItemSnapshot> {
  if (scope === "local") {
    return {
      source: "filesystem",
      localPath: path,
      sha: await shaOfItem(path),
      files: await itemFiles(path),
    };
  }
  return {
    source: "git-visible",
    localPath: path,
    sha: await shaOfGitVisibleItem(project, relPath),
    files: await gitVisibleFilesUnderPath(project, relPath),
  };
}

async function itemFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(root, ...rel.split("/")) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnoredDotDirent(entry)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await walk("");
  out.sort();
  return out;
}

function assertCanNormalizeAdoptedSkill(
  project: string,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
): void {
  if (mode !== "codex-compatible") return;
  if (adoption.kind === "claude-real") return;

  const managedPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (!stat) return;
  if (!stat.isSymbolicLink()) {
    throw new PreconditionError(
      `compatibility path already exists but is not a symlink: ${claudePath}`,
    );
  }

  const target = resolve(dirname(claudePath), readlinkSync(claudePath));
  if (resolve(target) !== resolve(managedPath)) {
    throw new PreconditionError(
      `compatibility symlink points somewhere else: ${claudePath} -> ${target}\n` +
        `  expected it to point at: ${managedPath}`,
    );
  }
}

function findAdoptionSource(
  project: string,
  kind: ItemKind,
  name: string,
  mode: Manifest["installMode"],
): AdoptionSource | null {
  if (kind === "mcp") {
    return existingItemDir(
      installedPath(project, kind, name, mode),
      "installed",
      kind,
    );
  }
  if (kind === "settings") return null;

  if (mode === "claude-only") {
    const path = claudeSkillPath(project, name);
    return existingItemDir(path, "installed", kind);
  }

  const codexPath = codexSkillPath(project, name);
  const claudePath = claudeSkillPath(project, name);
  const codex = existingItemDir(codexPath, "installed", kind);
  const claudeStat = lstatOrNull(claudePath);

  if (codex && claudeStat && !claudeStat.isSymbolicLink()) {
    throw new PreconditionError(
      `ambiguous local skill paths for skills/${name}: ${codexPath} and ${claudePath}\n` +
        "  remove one path or make .claude/skills point at .agents/skills before adopting",
    );
  }
  if (codex) return codex;

  if (claudeStat?.isSymbolicLink()) {
    return existingItemDir(
      installedPath(project, "skills", name, mode),
      "installed",
      kind,
    );
  }
  if (claudeStat) return existingItemDir(claudePath, "claude-real", kind);
  return null;
}

function existingItemDir(
  path: string,
  sourceKind: AdoptionSource["kind"],
  kind: ItemKind,
): AdoptionSource | null {
  const stat = lstatOrNull(path);
  if (!stat) return null;
  if (!stat.isDirectory()) {
    throw new PreconditionError(
      `local ${kind} path is not a directory: ${path}`,
    );
  }
  if (kind === "skills" && !existsSync(join(path, "SKILL.md"))) {
    throw new PreconditionError(`local skill is missing SKILL.md: ${path}`);
  }
  return { path, kind: sourceKind };
}

async function normalizeAdoptedSkill(
  project: string,
  name: string,
  adoption: AdoptionSource,
  mode: Manifest["installMode"],
): Promise<void> {
  if (mode !== "codex-compatible") return;

  if (adoption.kind === "claude-real") {
    const managedPath = codexSkillPath(project, name);
    const adoptionRelPath = relative(project, adoption.path);
    await replaceDirFromGitVisibleFiles(
      project,
      adoptionRelPath,
      adoption.path,
      managedPath,
    );
    await fsRm(adoption.path, { recursive: true, force: true });
  }
  await ensureInstallAliases(project, "skills", name, mode);
}

function expectedAdoptionPath(
  project: string,
  kind: ItemKind,
  name: string,
  mode: Manifest["installMode"],
): string {
  if (kind === "skills" && mode !== "claude-only") {
    return `${codexSkillPath(project, name)} or ${claudeSkillPath(project, name)}`;
  }
  return installedPath(project, kind, name, mode);
}

function dataEntriesMatch(a: DataLockEntry, b: DataLockEntry): boolean {
  return (
    a.source === b.source &&
    a.sha === b.sha &&
    a.sourceCommit === b.sourceCommit
  );
}

function dataEntryOrThrow(
  entry: Lock["items"][string] | undefined,
  key: string,
): DataLockEntry {
  if (entry?.source !== "data") {
    throw new Error(`expected data lock entry for ${key}`);
  }
  return entry;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export function addToManifest(m: Manifest, kind: ItemKind, name: string): void {
  addManifestName(m, kind, name);
}

function removeFromManifest(m: Manifest, kind: ItemKind, name: string): void {
  removeManifestName(m, kind, name);
}

function refDisplay(ref: ReturnType<typeof parseItemRef>): string {
  return `${ref.kind ? `${ref.kind}/` : ""}${ref.name}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
