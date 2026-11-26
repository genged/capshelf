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

type CandidateSource = "override" | "local" | "env";

interface DataRepoCandidate {
  path: string;
  /**
   * Recorded bindings can go stale (clone moved, renamed, or not restored); a
   * `--data` value is typed into the running command so it cannot.
   */
  source: CandidateSource;
}

interface RejectedBinding {
  path: string;
  source: Exclude<CandidateSource, "override">;
  reason: "does not exist" | "is not a Git repository";
}

interface Resolution {
  path: string | null;
  rejected: RejectedBinding | null;
}

async function candidateDataRepo(
  opts: ResolveOpts,
): Promise<DataRepoCandidate | null> {
  if (opts.override) {
    return { path: normalizePath(opts.override), source: "override" };
  }
  if (opts.project) {
    const localConfig = await loadLocalConfig(opts.project);
    if (localConfig) {
      return {
        path: normalizePath(localConfig.dataRepo, opts.project),
        source: "local",
      };
    }
  }
  const home = process.env[HOME_ENV];
  if (home) return { path: normalizePath(home), source: "env" };
  return null;
}

/**
 * Check for a Git repository before asking it for `origin`. A path that holds
 * no repository answers "no origin", and the repair for that upstream error
 * cannot run in a directory that does not exist.
 */
async function resolveBinding(opts: ResolveOpts): Promise<Resolution> {
  const candidate = await candidateDataRepo(opts);
  if (candidate === null) return { path: null, rejected: null };
  const present = existsSync(candidate.path);
  if (present && (await isGitRepo(candidate.path))) {
    if (opts.manifest) {
      await verifyDataRepoUpstream(candidate.path, opts.manifest);
    }
    return { path: candidate.path, rejected: null };
  }
  // A recorded binding with no clone is treated as no binding, routing to the
  // clone-and-rebind repair; a `--data` path is returned as-is so
  // `assertDataRepoRoot` names the wrong path.
  if (candidate.source === "override") {
    return { path: candidate.path, rejected: null };
  }
  return {
    path: null,
    rejected: {
      path: candidate.path,
      source: candidate.source,
      reason: present ? "is not a Git repository" : "does not exist",
    },
  };
}

function noConfigMessage(
  manifest: Manifest | null | undefined,
  rejected: RejectedBinding | null,
): string {
  const source =
    rejected?.source === "local"
      ? `${METADATA_DIR}/${LOCAL_CONFIG_FILE}`
      : `$${HOME_ENV}`;
  const fact = rejected
    ? `recorded data repo ${rejected.path} (from ${source}) ${rejected.reason}.\n`
    : "";
  if (manifest?.dataRepoUpstream) {
    return (
      "no data repo configured for this project.\n" +
      fact +
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
    "no data repo configured for this project.\n" +
    fact +
    "\n" +
    (rejected?.source === "local"
      ? `  pass --data <path>, or bind a clone in ${METADATA_DIR}/${LOCAL_CONFIG_FILE}:\n` +
        `    ${PRODUCT_NAME} set-data <path>\n`
      : `  pass --data <path>, or create ${METADATA_DIR}/${LOCAL_CONFIG_FILE}:\n` +
        `    mkdir -p ${METADATA_DIR}\n` +
        `    echo '{"dataRepo": "/path/to/clone"}' > ${METADATA_DIR}/${LOCAL_CONFIG_FILE}\n`) +
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
  const { path, rejected } = await resolveBinding(opts);
  if (path !== null) return path;
  throw new DataRepoNotConfiguredError(
    noConfigMessage(opts.manifest, rejected),
  );
}

export async function resolveDataRepoOptional(
  opts: ResolveOpts,
): Promise<string | null> {
  return (await resolveBinding(opts)).path;
}
