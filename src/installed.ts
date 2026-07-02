import { existsSync, readlinkSync } from "node:fs";
import { lstatOrNull } from "./fs-utils";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { ITEM_KINDS, isItemKind, type ItemKind } from "./master";
import { shaOfGitVisibleItem, shaOfItem } from "./master";
import { isGitWorkTreeRoot } from "./git";
import {
  claudeDir,
  codexProjectConfigDir,
  codexDir,
  detectInstallMode,
  installBaseDir,
} from "./paths";
import type { InstallMode } from "./paths";

export function installedPath(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): string {
  if (kind === "skills") return skillInstalledPath(project, name, mode);

  switch (kind) {
    case "settings":
      return join(claudeDir(project), "settings.json");
    case "mcp":
      return join(project, ".mcp.json");
    case "codex-config":
      return join(codexProjectConfigDir(project), "config.toml");
  }
}

export function claudeSkillPath(project: string, name: string): string {
  return join(claudeDir(project), "skills", name);
}

export function codexSkillPath(project: string, name: string): string {
  return join(codexDir(project), "skills", name);
}

export function findInstallConflict(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): string | null {
  const dst = installedPath(project, kind, name, mode);
  if (pathExists(dst)) return dst;

  if (kind === "skills" && mode === "codex-compatible") {
    const claudePath = claudeSkillPath(project, name);
    if (pathExists(claudePath)) return claudePath;
  }

  return null;
}

export function assertCanMaterializeInstalled(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): void {
  if (kind !== "skills" || mode !== "codex-compatible") return;

  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (!stat || stat.isSymbolicLink()) return;

  throw new Error(
    `compatibility path already exists but is not a symlink: ${claudePath}`,
  );
}

export async function ensureInstallAliases(
  project: string,
  kind: ItemKind,
  name: string,
  mode: InstallMode = detectInstallMode(project),
): Promise<void> {
  if (kind !== "skills" || mode !== "codex-compatible") return;

  const dst = installedPath(project, kind, name, mode);
  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);

  if (stat) {
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `compatibility path already exists but is not a symlink: ${claudePath}`,
      );
    }
    const existingTarget = resolveSymlinkTarget(claudePath);
    if (samePath(existingTarget, dst)) return;
    throw new Error(
      `compatibility symlink points somewhere else: ${claudePath} -> ${existingTarget}`,
    );
  }

  await mkdir(dirname(claudePath), { recursive: true });
  await symlink(relative(dirname(claudePath), dst), claudePath, "dir");
}

export async function removeInstallAliases(
  project: string,
  kind: ItemKind,
  name: string,
  managedPath: string,
  mode: InstallMode = detectInstallMode(project),
): Promise<boolean> {
  if (kind !== "skills" || mode !== "codex-compatible") return false;

  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (!stat?.isSymbolicLink()) return false;

  const target = resolveSymlinkTarget(claudePath);
  if (samePath(target, managedPath)) {
    await rm(claudePath, { force: true });
    return true;
  }
  return false;
}

export function isInstalled(
  project: string,
  kind: ItemKind,
  name: string,
): boolean {
  return existsSync(installedPath(project, kind, name));
}

export async function shaOfInstalled(
  project: string,
  kind: ItemKind,
  name: string,
): Promise<string | null> {
  const p = installedPath(project, kind, name);
  if (!existsSync(p)) return null;
  if (await isGitWorkTreeRoot(project)) {
    const rel = relative(project, p);
    if (rel && !rel.startsWith("..")) {
      return shaOfGitVisibleItem(project, rel);
    }
  }
  return shaOfItem(p);
}

export type ItemSource = "data" | "system";

export function parseLockKey(key: string): {
  source: ItemSource;
  kind: ItemKind;
  name: string;
} {
  const parts = key.split("/");
  if (parts.length < 3) {
    throw new Error(`invalid lock key: ${key} (expected source/kind/name)`);
  }
  const [source, kind, ...nameParts] = parts;
  if (source !== "data" && source !== "system") {
    throw new Error(`invalid lock key source: ${source}`);
  }
  if (!kind || !isItemKind(kind)) {
    throw new Error(
      `unsupported lock key kind: ${kind ?? "(missing)"} (supported: ${ITEM_KINDS.join(", ")})`,
    );
  }
  const name = nameParts.join("/");
  // The name becomes a filesystem path segment (installedPath) and a git
  // pathspec (materialize). Reject traversal/absolute/option-like names so a
  // hostile lockfile can't escape the project or the data-repo item dir.
  if (
    nameParts.some((part) => part === "" || part === "." || part === "..") ||
    name.startsWith("/") ||
    name.startsWith("-")
  ) {
    throw new Error(`invalid lock key name: ${key}`);
  }
  return {
    source,
    kind,
    name,
  };
}

function skillInstalledPath(
  project: string,
  name: string,
  mode: InstallMode,
): string {
  const canonical = join(installBaseDir(project, mode), "skills", name);
  const claudePath = claudeSkillPath(project, name);
  const stat = lstatOrNull(claudePath);
  if (stat?.isSymbolicLink()) {
    const symlinkTarget = resolveSymlinkTarget(claudePath);
    // The compatibility alias must resolve to the managed skill location.
    // Materialize/sync delete-and-rewrite whatever path this returns, so
    // following a stray or hostile symlink that points elsewhere would let it
    // wipe an arbitrary directory. Refuse instead of following it.
    if (!samePath(symlinkTarget, canonical)) {
      const codexPath = codexSkillPath(project, name);
      if (
        mode === "codex-compatible" &&
        pathExists(codexPath) &&
        !samePath(codexPath, symlinkTarget)
      ) {
        throw new Error(
          `ambiguous skill install paths for skills/${name}: ${codexPath} and ${claudePath} -> ${symlinkTarget}`,
        );
      }
      throw new Error(
        `compatibility symlink for skills/${name} resolves outside the managed skills dir: ${claudePath} -> ${symlinkTarget}`,
      );
    }
    return canonical;
  }

  return canonical;
}

function pathExists(path: string): boolean {
  return lstatOrNull(path) !== null;
}

function resolveSymlinkTarget(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

function samePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}
