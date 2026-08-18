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

// Data-repo resolution lives here, not in paths.ts, because it depends upward
// on manifest / local-config / upstream-check. Keeping it out of paths.ts lets
// paths.ts stay a leaf of pure path builders, breaking the cycle those modules
// otherwise formed with it. This module depends one-way on paths (normalizePath).

interface ResolveOpts {
  override?: string;
  manifest?: Manifest | null;
  project?: string;
}

interface DataRepoCandidate {
  path: string;
  /**
   * True for `.capshelf/local.json` and `$CAPSHELF_HOME`. Both were written
   * earlier and can go stale while nobody is looking — the clone gets moved,
   * renamed, or not restored with the rest of the machine. A `--data` value is
   * typed into the command that is running, so it cannot go stale.
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
 * The candidate path, checked for a Git repository before anything asks that
 * repository a question.
 *
 * The order matters. `verifyDataRepoUpstream` asks the clone for its `origin`,
 * and a path that holds no repository answers "no origin" — so a binding whose
 * clone is gone used to fail every command with an upstream error whose repair,
 * `git -C <gone> remote add origin <url>`, cannot run in a directory that does
 * not exist.
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
  // A recorded binding that names no clone is the same state as no binding,
  // and it has the same repair: clone the upstream, bind it again, retry.
  // `noConfigMessage` is that repair, so returning null routes to it (exit 6)
  // and lets `status` report its data rows as missing_upstream (exit 0).
  //
  // A `--data` path is returned unchanged. The user named it in this command,
  // so the caller reports it: `assertDataRepoRoot` names the path that is wrong
  // (exit 3) instead of claiming the project has no data repo configured.
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
 * Resolve which data repo to use. Order:
 *   1. --data CLI flag (override)
 *   2. .capshelf/local.json dataRepo field (project-local binding)
 *   3. $CAPSHELF_HOME env var (machine default)
 *
 * Throws when none are set, and when a recorded binding names no Git
 * repository: a clone that is gone is not a binding. There is no implicit
 * default — that was an explicit decision (ADR-009) to prevent silent binding
 * to the wrong repo.
 */
export async function resolveDataRepo(opts: ResolveOpts): Promise<string> {
  const r = await resolveOptional(opts);
  if (r !== null) return r;
  // Distinct, recoverable state with its own documented exit code (6): the user
  // resolves it by passing --data, setting local.json, or $CAPSHELF_HOME.
  throw new DataRepoNotConfiguredError(noConfigMessage(opts.manifest));
}

/**
 * Same as resolveDataRepo but returns null instead of throwing when nothing is
 * configured, or when a recorded binding names no clone. Used by `status` so it
 * can degrade gracefully — items show as `missing_upstream` rather than
 * crashing the report.
 */
export async function resolveDataRepoOptional(
  opts: ResolveOpts,
): Promise<string | null> {
  return await resolveOptional(opts);
}
