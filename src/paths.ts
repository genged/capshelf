import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  LOCAL_LOCK_FILE,
  LOCK_FILE,
  MANIFEST_FILE,
  METADATA_DIR,
  PRODUCT_NAME,
} from "./identity";

// paths.ts is a leaf: pure path builders plus install-mode detection, no
// imports from manifest / local-config / upstream-check. Data-repo resolution,
// which needs those, lives in data-repo.ts.

export const InstallModeSchema = z.enum(["codex-compatible", "claude-only"]);
export type InstallMode = z.infer<typeof InstallModeSchema>;
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

export function normalizePath(
  p: string,
  baseDir: string = process.cwd(),
): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/**
 * The nearest ancestor of `cwd` that is a capshelf project, or null. Walks up
 * like git/npm/cargo. Read-only commands (ls/search/show) use this so they can
 * run with only `--data`/`$CAPSHELF_HOME` when the cwd isn't inside a project.
 */
export function findProjectRoot(cwd: string = process.cwd()): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(manifestPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

export function projectRoot(cwd: string = process.cwd()): string {
  const found = findProjectRoot(cwd);
  if (found) return found;
  const start = resolve(cwd);
  throw new Error(
    `not a capshelf project: ${start}\n` +
      `  run this from a capshelf project (a directory, or any subdirectory of one, containing ${METADATA_DIR}/${MANIFEST_FILE}),\n` +
      `  or initialize the current directory with: ${PRODUCT_NAME} init --data <path>`,
  );
}

export function initProjectRoot(cwd: string = process.cwd()): string {
  return resolve(cwd);
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

const ManifestInstallModeSchema = z.object({
  installMode: InstallModeSchema.optional(),
});

// installedPath and friends default their `mode` to detectInstallMode(project),
// and they run in per-item loops in status/apply/update — so without a cache
// each item re-read and re-parsed the manifest. Memoize per resolved project
// path for the process; saveManifest invalidates the entry it may have changed.
const installModeCache = new Map<string, InstallMode>();

export function clearInstallModeCache(project?: string): void {
  if (project === undefined) installModeCache.clear();
  else installModeCache.delete(resolve(project));
}

export function detectInstallMode(project: string): InstallMode {
  const key = resolve(project);
  const cached = installModeCache.get(key);
  if (cached !== undefined) return cached;
  const mode = readInstallMode(project);
  installModeCache.set(key, mode);
  return mode;
}

function readInstallMode(project: string): InstallMode {
  const source = manifestReadPath(project) ?? manifestPath(project);
  if (!existsSync(source)) return DEFAULT_INSTALL_MODE;
  const parsed = ManifestInstallModeSchema.parse(
    JSON.parse(readFileSync(source, "utf-8")),
  );
  return parsed.installMode ?? DEFAULT_INSTALL_MODE;
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
