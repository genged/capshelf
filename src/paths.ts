import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Manifest } from "./manifest";
import {
  HOME_ENV,
  LOCAL_CONFIG_FILE,
  LOCAL_LOCK_FILE,
  LOCK_FILE,
  MANIFEST_FILE,
  METADATA_DIR,
  PRODUCT_NAME,
} from "./identity";
import { loadLocalConfig } from "./local-config";
import { verifyDataRepoUpstream } from "./upstream-check";

export type InstallMode = "codex-compatible" | "claude-only";
export const DEFAULT_INSTALL_MODE: InstallMode = "codex-compatible";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Compress an absolute path under $HOME to ~/… for display.
 */
export function homeRelative(p: string): string {
  const home = homedir();
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

interface ResolveOpts {
  override?: string;
  manifest?: Manifest | null;
  project?: string;
}

export function normalizePath(
  p: string,
  baseDir: string = process.cwd(),
): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
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
    `    export ${HOME_ENV}=/path/to/clone`
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

export function projectRoot(cwd: string = process.cwd()): string {
  let d = resolve(cwd);
  while (d !== "/" && d.length > 1) {
    if (existsSync(join(d, ".git"))) return d;
    const parent = resolve(d, "..");
    if (parent === d) break;
    d = parent;
  }
  return cwd;
}

export function isInstallMode(value: string): value is InstallMode {
  return value === "codex-compatible" || value === "claude-only";
}

export function claudeDir(project: string): string {
  return join(project, ".claude");
}

export function claudeHomeDir(): string {
  return join(homedir(), ".claude");
}

export function personalClaudeSkillPath(name: string): string {
  return join(claudeHomeDir(), "skills", name);
}

export function codexDir(project: string): string {
  return join(project, ".agents");
}

export function codexProjectConfigDir(project: string): string {
  return join(project, ".codex");
}

export function installBaseDir(
  project: string,
  mode: InstallMode = detectInstallMode(project),
): string {
  return mode === "claude-only" ? claudeDir(project) : codexDir(project);
}

export function detectInstallMode(project: string): InstallMode {
  const source = manifestReadPath(project) ?? manifestPath(project);
  if (!existsSync(source)) return DEFAULT_INSTALL_MODE;

  const parsed = JSON.parse(readFileSync(source, "utf-8")) as {
    installMode?: unknown;
  };
  if (parsed.installMode === undefined) return DEFAULT_INSTALL_MODE;
  if (
    typeof parsed.installMode === "string" &&
    isInstallMode(parsed.installMode)
  ) {
    return parsed.installMode;
  }
  throw new Error(
    `invalid installMode in ${source}: expected codex-compatible or claude-only`,
  );
}

export function manifestPath(project: string): string {
  return join(project, METADATA_DIR, MANIFEST_FILE);
}

export function rootManifestPath(project: string): string {
  return join(project, MANIFEST_FILE);
}

export function lockPath(project: string): string {
  return join(project, METADATA_DIR, LOCK_FILE);
}

export function localLockPath(project: string): string {
  return join(project, METADATA_DIR, LOCAL_LOCK_FILE);
}

export function rootLockPath(project: string): string {
  return join(project, LOCK_FILE);
}

export function manifestReadPath(project: string): string | null {
  for (const path of [manifestPath(project), rootManifestPath(project)]) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function lockReadPath(project: string): string | null {
  for (const path of [lockPath(project), rootLockPath(project)]) {
    if (existsSync(path)) return path;
  }
  return null;
}
