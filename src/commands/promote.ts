import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { projectRoot, resolveDataRepo } from "../paths";
import { loadManifest, saveManifest } from "../manifest";
import type { Manifest } from "../manifest";
import {
  dataKey,
  loadLocalLock,
  loadLock,
  saveLocalLock,
  saveLock,
} from "../lock";
import type { Lock } from "../lock";
import { installedPath, parseLockKey } from "../installed";
import type { ItemKind } from "../master";
import { NotFoundError, PreconditionError } from "../errors";
import {
  assertIsGitRepo,
  assertRepoCleanOutsidePath,
  assertRepoCleanOutsidePaths,
  commitInRepo,
  lastTouchingCommit,
  statusPorcelain,
} from "../git";
import { isSystemItemName } from "../bundled";
import { globalOpts } from "../cli";
import { lockKeyForRef, parseItemRef } from "../item-ref";
import { assertLocalScopeSupported } from "../local-config";
import { replaceDirFromFiles, replaceDirFromGitVisibleFiles } from "../sync";
import { findSkillsShSkill, skillsShConflictMessage } from "../external";
import {
  printRuntimeWarnings,
  runtimeWarningsForItem,
} from "../runtime-warnings";
import { printPrivateDotenvWarnings, privateDotenvFiles } from "../dotfiles";
import {
  allCanonicalFragmentRelPaths,
  applyFragmentOutput,
  currentFragmentSourcesForItem,
  isFragmentKind,
  parseFragmentSourceText,
  shaOfFragmentItem,
  touchedFragmentTargetsForItem,
} from "../fragments";
import {
  addToManifest,
  dataEntryOrThrow,
  refDisplay,
  type PromoteResult,
  type Scope,
} from "../promote-core";
import { adoptIntoDataRepo } from "../data-repo-adopt";
import { installedSnapshot } from "../item-snapshot";

interface PromoteOptions {
  create?: boolean;
  message?: string;
  json?: boolean;
  local?: boolean;
}

interface SyncOptions {
  message?: string;
  scope?: Scope;
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
  // Throws a PreconditionError when the data repo has no canonical source
  // files (the only expected empty case); letting it surface means genuine
  // git/fs failures propagate instead of being masked as "no source files."
  const existingSources = await currentFragmentSourcesForItem(
    dataRepo,
    kind,
    name,
  );

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

  const oldLock = structuredClone(lock);
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
    await replaceDirFromFiles(
      localPath,
      snapshot.files,
      join(dataRepo, repoRelPath),
    );
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
