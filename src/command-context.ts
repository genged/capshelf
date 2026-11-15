import type { Command } from "commander";
import { assertDataRepoRoot } from "./git";
import { globalOpts } from "./global-options";
import { loadLocalLock, loadLock } from "./lock";
import type { Lock } from "./lock";
import { loadManifest } from "./manifest";
import type { Manifest } from "./manifest";
import { projectRoot } from "./paths";
import { resolveDataRepo } from "./data-repo";
import { assertNoScopeCollisions } from "./status-core";

export interface ProjectContext {
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  dataRepo?: string;
}

export interface LoadContextOptions {
  cmd: Command;
  dataRepo?: boolean;
  assertScopes?: boolean;
}

export async function loadProjectContext(
  opts: LoadContextOptions,
): Promise<ProjectContext> {
  const project = projectRoot();
  const [manifest, projectLock, localLock] = await Promise.all([
    loadManifest(project),
    loadLock(project),
    loadLocalLock(project),
  ]);
  if (opts.assertScopes) assertNoScopeCollisions(projectLock, localLock);

  let dataRepo: string | undefined;
  if (opts.dataRepo) {
    dataRepo = await resolveProjectDataRepo(project, manifest, opts.cmd);
  }
  return { project, manifest, projectLock, localLock, dataRepo };
}

/**
 * Split out so commands that need a data repo only conditionally (apply/update)
 * can resolve it after deciding.
 */
export async function resolveProjectDataRepo(
  project: string,
  manifest: Manifest,
  cmd: Command,
): Promise<string> {
  const dataRepo = await resolveDataRepo({
    override: globalOpts(cmd).data,
    manifest,
    project,
  });
  await assertDataRepoRoot(dataRepo);
  return dataRepo;
}
