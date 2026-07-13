import type { Command } from "commander";
import { assertIsGitRepo } from "./git";
import { globalOpts } from "./global-options";
import { loadLocalLock, loadLock } from "./lock";
import type { Lock } from "./lock";
import { loadManifest } from "./manifest";
import type { Manifest } from "./manifest";
import { projectRoot } from "./paths";
import { resolveDataRepo } from "./data-repo";
import { assertNoScopeCollisions } from "./status-core";

/**
 * The state every project command loads before it does anything: the project
 * root (discovered upward from cwd), the portable manifest, and both lockfiles.
 * Ten commands used to retype this sequence inline; loading it in one place
 * keeps them consistent and gives cross-cutting guards (scope-collision, data
 * repo resolution) a single home.
 */
export interface ProjectContext {
  project: string;
  manifest: Manifest;
  projectLock: Lock;
  localLock: Lock;
  /** Present only when `dataRepo: true` was requested. */
  dataRepo?: string;
}

export interface LoadContextOptions {
  /** The command, used to read the global `--data` override. */
  cmd: Command;
  /** Resolve the data repo (honoring --data / local.json / env) and assert it
   *  is a git repo. Omit when the command resolves it conditionally itself. */
  dataRepo?: boolean;
  /** Refuse when an item is owned by both project and local scope. */
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
 * Resolve the data repo for a project and assert it is a usable git repo. Split
 * out so commands that decide whether they need a data repo (apply/update only
 * need one when a target is a data item) can call it after that decision.
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
  await assertIsGitRepo(dataRepo);
  return dataRepo;
}
