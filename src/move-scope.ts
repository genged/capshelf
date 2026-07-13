import { existsSync } from "node:fs";
import { join } from "node:path";
import { itemRepoRelPath } from "./master";
import type { ItemKind } from "./master";
import { dataKey } from "./lock";
import type { DataLockEntry } from "./lock";
import { CheckFailedError, NotFoundError, PreconditionError } from "./errors";
import {
  assertLocalInstallPathsUntracked,
  assertLocalScopeSupported,
} from "./local-config";
import {
  addToManifest,
  dataEntriesMatch,
  dataEntryOrThrow,
  removeFromManifest,
  type MoveScopeResult,
  type MoveScopeState,
  type Scope,
} from "./promote-core";
import { installedSnapshot } from "./item-snapshot";

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
  if (kind !== "skills" && localEntry !== undefined) {
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

  const repoRelPath = itemRepoRelPath(kind, name);
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
