import { existsSync } from "node:fs";
import {
  HOME_ENV,
  LOCAL_CONFIG_FILE,
  MANIFEST_FILE,
  METADATA_DIR,
  PRODUCT_NAME,
} from "./identity";
import { DataRepoNotConfiguredError } from "./errors";
import { isGitRepo } from "./git";
import { loadLocalConfig } from "./local-config";
import type { Manifest } from "./manifest";
import { normalizePath } from "./paths";
import { verifyDataRepoUpstream } from "./upstream-check";

// Lives here, not in paths.ts, because it depends on
// manifest/local-config/upstream-check; this keeps paths.ts a leaf and avoids
// an import cycle.

interface ResolveOpts {
  override?: string;
  manifest?: Manifest | null;
  project?: string;
}

interface DataRepoCandidate {
  path: string;
  /**
   * Recorded bindings can go stale (clone moved, renamed, or not restored); a
   * `--data` value is typed into the running command so it cannot.
   */
  recorded: boolean;
}

async function candidateDataRepo(
  opts: ResolveOpts,
): Promise<DataRepoCandidate | null> {
  if (opts.override) {
    return { path: normalizePath(opts.override), recorded: false };
  }
  if (opts.project) {
    const localConfig = await loadLocalConfig(opts.project);
    if (localConfig) {
      return {
        path: normalizePath(localConfig.dataRepo, opts.project),
        recorded: true,
      };
    }
  }
  const home = process.env[HOME_ENV];
  if (home) return { path: normalizePath(home), recorded: true };
  return null;
}

/**
 * Check for a Git repository before asking it for `origin`. A path that holds
 * no repository answers "no origin", and the repair for that upstream error
 * cannot run in a directory that does not exist.
 */
async function resolveOptional(opts: ResolveOpts): Promise<string | null> {
  const candidate = await candidateDataRepo(opts);
  if (candidate === null) return null;
  if (existsSync(candidate.path) && (await isGitRepo(candidate.path))) {
    if (opts.manifest) {
      await verifyDataRepoUpstream(candidate.path, opts.manifest);
    }
    return candidate.path;
  }
  // A recorded binding with no clone is treated as no binding, routing to the
  // clone-and-rebind repair; a `--data` path is returned as-is so
  // `assertDataRepoRoot` names the wrong path.
  return candidate.recorded ? null : candidate.path;
}

function noConfigMessage(manifest: Manifest | null | undefined): string {
  if (manifest?.dataRepoUpstream) {
    return (
      "no data repo configured for this project.\n" +
      `upstream (per ${METADATA_DIR}/${MANIFEST_FILE}): ${manifest.dataRepoUpstream}\n\n` +
      "  1. clone it somewhere you control:\n" +
      `       git clone ${manifest.dataRepoUpstream} <path>\n` +
      "  2. point capshelf at it:\n" +
      `       ${PRODUCT_NAME} set-data <path>\n` +
      "  3. retry:\n" +
      `       ${PRODUCT_NAME} apply`
    );
  }
  return (
    "no data repo configured for this project.\n\n" +
    `  pass --data <path>, or create ${METADATA_DIR}/${LOCAL_CONFIG_FILE}:\n` +
    `    mkdir -p ${METADATA_DIR}\n` +
    `    echo '{"dataRepo": "/path/to/clone"}' > ${METADATA_DIR}/${LOCAL_CONFIG_FILE}\n` +
    "  or set the env var for machine-wide default:\n" +
    `    export ${HOME_ENV}=/path/to/clone\n\n` +
    `  if this is a cloned project, ${METADATA_DIR}/${MANIFEST_FILE} does not declare dataRepoUpstream,\n` +
    "  so capshelf cannot tell you which data repo to clone. Ask a maintainer\n" +
    "  for the data repo URL, then make it discoverable with:\n" +
    `    ${PRODUCT_NAME} set-upstream <data-repo-url>`
  );
}

/**
 * No implicit default is used, to prevent silent binding to an unintended
 * repository.
 */
export async function resolveDataRepo(opts: ResolveOpts): Promise<string> {
  const r = await resolveOptional(opts);
  if (r !== null) return r;
  throw new DataRepoNotConfiguredError(noConfigMessage(opts.manifest));
}

export async function resolveDataRepoOptional(
  opts: ResolveOpts,
): Promise<string | null> {
  return await resolveOptional(opts);
}
