import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

export function projectRoot(cwd: string = process.cwd()): string {
  const project = resolve(cwd);
  if (existsSync(manifestPath(project))) return project;
  throw new Error(
    `not a capshelf project root: ${project}\n` +
      `  run this command from the directory containing ${METADATA_DIR}/${MANIFEST_FILE}, or initialize this directory with: ${PRODUCT_NAME} init --data <path>`,
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

export function detectInstallMode(project: string): InstallMode {
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
