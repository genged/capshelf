import {
  HOME_ENV,
  LOCAL_CONFIG_FILE,
  MANIFEST_FILE,
  METADATA_DIR,
  PRODUCT_NAME,
} from "./identity";
import { loadLocalConfig } from "./local-config";
import type { Manifest } from "./manifest";
import { normalizePath } from "./paths";
import { verifyDataRepoUpstream } from "./upstream-check";

// Data-repo resolution lives here, not in paths.ts, because it depends upward
// on manifest / local-config / upstream-check. Keeping it out of paths.ts lets
// paths.ts stay a leaf of pure path builders, breaking the cycle those modules
// otherwise formed with it. This module depends one-way on paths (normalizePath).

interface ResolveOpts {
  override?: string;
  manifest?: Manifest | null;
  project?: string;
}

async function resolveOptional(opts: ResolveOpts): Promise<string | null> {
  if (opts.override) {
    const dataRepo = normalizePath(opts.override);
    await verifyResolvedUpstream(dataRepo, opts);
    return dataRepo;
  }
  if (opts.project) {
    const localConfig = await loadLocalConfig(opts.project);
    if (localConfig) {
      const dataRepo = normalizePath(localConfig.dataRepo, opts.project);
      await verifyResolvedUpstream(dataRepo, opts);
      return dataRepo;
    }
  }
  if (process.env[HOME_ENV]) {
    const dataRepo = normalizePath(process.env[HOME_ENV]);
    await verifyResolvedUpstream(dataRepo, opts);
    return dataRepo;
  }
  return null;
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
 * Resolve which data repo to use. Order:
 *   1. --data CLI flag (override)
 *   2. .capshelf/local.json dataRepo field (project-local binding)
 *   3. $CAPSHELF_HOME env var (machine default)
 *
 * Throws if none are set. There is no implicit default — that was an explicit
 * decision (ADR-009) to prevent silent binding to the wrong repo.
 */
export async function resolveDataRepo(opts: ResolveOpts): Promise<string> {
  const r = await resolveOptional(opts);
  if (r !== null) return r;
  throw new Error(noConfigMessage(opts.manifest));
}

/**
 * Same as resolveDataRepo but returns null instead of throwing when nothing
 * is configured. Used by `status` so it can degrade gracefully — items show as
 * `missing_upstream` rather than crashing the report.
 */
export async function resolveDataRepoOptional(
  opts: ResolveOpts,
): Promise<string | null> {
  return await resolveOptional(opts);
}

async function verifyResolvedUpstream(
  dataRepo: string,
  opts: ResolveOpts,
): Promise<void> {
  if (opts.manifest) {
    await verifyDataRepoUpstream(dataRepo, opts.manifest);
  }
}
